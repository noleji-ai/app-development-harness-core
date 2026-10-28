import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { MAX_CAPTURE_BYTES, type ModelPolicy, modelConfig } from "./model-policy"
import { type ModelUsage, parseUsageEvents } from "./model-usage"
import { signalProcessGroup } from "./process-lifecycle"

const ENVIRONMENT_KEYS = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL"] as const

export type CodexTransportResult = (
  | {
      kind: "output"
      output: string
      transcriptHash: string
      transport: "exec" | "app-server"
      usage?: ModelUsage
    }
  | { kind: "failed"; error: string }
  | { kind: "unverified"; missingCapability: string }
) & { readonly safeToRetry?: boolean }

export interface CodexExecOptions {
  readonly projectRoot: string
  readonly binary: string
  readonly prompt: string
  readonly schemaPath: string
  readonly outputPath: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly policy?: ModelPolicy | undefined
}

type ProcessResult =
  | { kind: "closed"; code: number | null; stdout: Buffer; stderr: Buffer }
  | { kind: "unavailable"; error: string }
  | { kind: "cancelled" }
  | { kind: "timeout" }
  | { kind: "overflow" }

export function codexEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NO_COLOR: "1" }
  for (const key of ENVIRONMENT_KEYS) {
    const value = process.env[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

function contained(root: string, target: string): boolean {
  const route = relative(root, target)
  return route === "" || (route !== ".." && !route.startsWith(`..${sep}`))
}

export async function validateCodexBinary(binary: string): Promise<void> {
  if (binary === "codex") return
  if (!isAbsolute(binary) || binary.includes("\0")) {
    throw new Error("configured Codex binary must be an absolute path")
  }
  const state = await lstat(binary)
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    (state.mode & 0o111) === 0
  ) {
    throw new Error("configured Codex binary must be a non-symlink executable file")
  }
}

export function redactCodexDiagnostic(value: string): string {
  return value
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .slice(0, 2000)
}

function runProcess(options: CodexExecOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.resolve({ kind: "cancelled" })
  return new Promise((resolveResult) => {
    const child = spawn(
      options.binary,
      [
        "exec",
        ...(options.policy === undefined
          ? []
          : [
              "--profile",
              options.policy.profile,
              "--model",
              options.policy.model,
              ...Object.entries(modelConfig(options.policy)).flatMap(([key, value]) => [
                "-c",
                `${key}=${JSON.stringify(value)}`,
              ]),
            ]),
        "--json",
        "--ephemeral",
        "--color",
        "never",
        "-s",
        "workspace-write",
        "-C",
        options.projectRoot,
        "--skip-git-repo-check",
        "--output-schema",
        options.schemaPath,
        "-o",
        options.outputPath,
        "-",
      ],
      {
        cwd: options.projectRoot,
        env: codexEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let forcedKill: NodeJS.Timeout | undefined
    let finishReason: "cancelled" | "timeout" | "overflow" | undefined
    const finish = (result: ProcessResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forcedKill !== undefined) clearTimeout(forcedKill)
      options.signal?.removeEventListener("abort", cancel)
      signalProcessGroup(child, "SIGKILL")
      resolveResult(result)
    }
    const terminate = (reason: "cancelled" | "timeout" | "overflow") => {
      if (finishReason !== undefined) return
      finishReason = reason
      signalProcessGroup(child, "SIGTERM")
      forcedKill = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 500)
    }
    const cancel = () => terminate("cancelled")
    const capture = (chunks: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      if (stream === "stdout") stdoutBytes += chunk.length
      else stderrBytes += chunk.length
      if (stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes > MAX_CAPTURE_BYTES) {
        terminate("overflow")
        return
      }
      chunks.push(chunk)
    }
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk, "stdout"))
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk, "stderr"))
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish({ kind: "unavailable", error: error.message })
      else finish({ kind: "unavailable", error: redactCodexDiagnostic(error.message) })
    })
    child.once("close", (code) => {
      if (finishReason !== undefined) finish({ kind: finishReason })
      else
        finish({
          kind: "closed",
          code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        })
    })
    options.signal?.addEventListener("abort", cancel, { once: true })
    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs)
    child.stdin.on("error", () => undefined)
    child.stdin.end(options.prompt)
  })
}

function validJsonLines(contents: Buffer): boolean {
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents)
  } catch {
    return false
  }
  const lines = decoded.split("\n").filter((line) => line.trim() !== "")
  if (lines.length === 0) return false
  return lines.every((line) => {
    try {
      JSON.parse(line)
      return true
    } catch {
      return false
    }
  })
}

async function readBoundedOutput(projectRoot: string, outputPath: string): Promise<string> {
  const state = await lstat(outputPath)
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    state.size > MAX_CAPTURE_BYTES
  ) {
    throw new Error("Codex final output is not a bounded regular file")
  }
  const root = await realpath(resolve(projectRoot))
  if (!contained(root, await realpath(outputPath)))
    throw new Error("Codex final output escaped project")
  return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(outputPath))
}

export async function runCodexExec(options: CodexExecOptions): Promise<CodexTransportResult> {
  try {
    await validateCodexBinary(options.binary)
  } catch (error) {
    return {
      kind: "unverified",
      missingCapability: redactCodexDiagnostic(
        error instanceof Error ? error.message : String(error),
      ),
    }
  }
  const result = await runProcess(options)
  if (result.kind === "unavailable") {
    return {
      kind: "unverified",
      missingCapability: `codex-cli: ${redactCodexDiagnostic(result.error)}`,
    }
  }
  if (result.kind === "cancelled") return { kind: "unverified", missingCapability: "cancelled" }
  if (result.kind === "timeout") return { kind: "unverified", missingCapability: "codex-timeout" }
  if (result.kind === "overflow") return { kind: "failed", error: "Codex output exceeded limit" }
  if (result.code !== 0) {
    return {
      kind: "failed",
      error: redactCodexDiagnostic(result.stderr.toString("utf8") || "Codex exited"),
    }
  }
  if (!validJsonLines(result.stdout)) {
    return { kind: "failed", error: "Codex JSONL transcript is malformed" }
  }
  try {
    return {
      kind: "output",
      output: await readBoundedOutput(options.projectRoot, options.outputPath),
      transcriptHash: createHash("sha256").update(result.stdout).digest("hex"),
      transport: "exec",
      usage: parseUsageEvents(result.stdout.toString("utf8")),
    }
  } catch (error) {
    return {
      kind: "failed",
      error: redactCodexDiagnostic(error instanceof Error ? error.message : String(error)),
    }
  }
}
