import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { serverArguments } from "./app-server-endpoint"
import {
  type CodexTransportResult,
  codexEnvironment,
  redactCodexDiagnostic,
  validateCodexBinary,
} from "./codex-exec"
import { MAX_CAPTURE_BYTES, type ModelPolicy, modelConfig } from "./model-policy"
import { parseUsageEvents } from "./model-usage"
import { stopProcessGroup } from "./process-lifecycle"
import { CODEX_STAGE_OUTPUT_JSON_SCHEMA } from "./stage-contract"

export interface CodexAppServerOptions {
  readonly projectRoot: string
  readonly binary: string
  readonly prompt: string
  readonly timeoutMs: number
  readonly socket?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly policy?: ModelPolicy | undefined
}

function stringAt(value: unknown, keys: readonly string[]): string | undefined {
  let current = value
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined
    current = Reflect.get(current, key)
  }
  return typeof current === "string" ? current : undefined
}

function objectAt(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  let current = value
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined
    current = Reflect.get(current, key)
  }
  return typeof current === "object" && current !== null
    ? (current as Record<string, unknown>)
    : undefined
}

export async function runCodexAppServer(
  options: CodexAppServerOptions,
): Promise<CodexTransportResult> {
  if (options.signal?.aborted) return { kind: "unverified", missingCapability: "cancelled" }
  let args: string[]
  try {
    await validateCodexBinary(options.binary)
    args = await serverArguments(options.socket)
  } catch (error) {
    return {
      kind: "unverified",
      safeToRetry: true,
      missingCapability: redactCodexDiagnostic(
        error instanceof Error ? error.message : String(error),
      ),
    }
  }
  return new Promise((resolveResult) => {
    const child = spawn(options.binary, args, {
      cwd: options.projectRoot,
      env: codexEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    const transcript = createHash("sha256")
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let buffered = ""
    let capturedBytes = 0
    let stderr = ""
    let threadId: string | undefined
    const usageLines: string[] = []
    let settled = false
    let turnSubmitted = false
    let retryAllowed = true
    const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const finish = (result: CodexTransportResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      options.signal?.removeEventListener("abort", cancel)
      const completed = {
        ...result,
        safeToRetry:
          retryAllowed && !turnSubmitted && !options.signal?.aborted && result.kind !== "output",
      }
      void stopProcessGroup(child).then(
        () => resolveResult(completed),
        () =>
          resolveResult({
            kind: "failed",
            error: "app-server process cleanup failed",
            safeToRetry: false,
          }),
      )
    }
    const fail = (message: string) =>
      finish({ kind: "failed", error: redactCodexDiagnostic(message) })
    const cancel = () => finish({ kind: "unverified", missingCapability: "cancelled" })
    const handleMessage = (message: unknown) => {
      usageLines.push(JSON.stringify(message))
      const id =
        typeof message === "object" && message !== null ? Reflect.get(message, "id") : undefined
      const method = stringAt(message, ["method"])
      if (id === 1) {
        if (objectAt(message, ["error"])) return fail("app-server initialize failed")
        write({ method: "initialized", params: {} })
        write({
          id: 2,
          method: "thread/start",
          params: {
            cwd: options.projectRoot,
            runtimeWorkspaceRoots: [options.projectRoot],
            approvalPolicy: "never",
            sandbox: "workspace-write",
            ephemeral: true,
            ...(options.policy === undefined
              ? {}
              : {
                  model: options.policy.model,
                  allowProviderModelFallback: false,
                  config: modelConfig(options.policy),
                }),
          },
        })
        return
      }
      if (id === 2) {
        threadId = stringAt(message, ["result", "thread", "id"])
        if (threadId === undefined) return fail("app-server returned no thread id")
        if (
          options.policy !== undefined &&
          stringAt(message, ["result", "model"]) !== options.policy.model
        ) {
          retryAllowed = false
          return fail("app-server did not confirm the requested model")
        }
        turnSubmitted = true
        write({
          id: 3,
          method: "turn/start",
          params: {
            threadId,
            input: [{ type: "text", text: options.prompt }],
            cwd: options.projectRoot,
            runtimeWorkspaceRoots: [options.projectRoot],
            approvalPolicy: "never",
            outputSchema: CODEX_STAGE_OUTPUT_JSON_SCHEMA,
            ...(options.policy === undefined
              ? {}
              : {
                  model: options.policy.model,
                  effort: options.policy.effort,
                }),
          },
        })
        return
      }
      if ((typeof id === "number" || typeof id === "string") && method !== undefined) {
        return fail(`app-server requested unsupported interaction: ${method}`)
      }
      if (method === "error")
        return fail(stringAt(message, ["params", "message"]) ?? "app-server error")
      if (method === "model/rerouted" && stringAt(message, ["params", "threadId"]) === threadId) {
        return fail("app-server rerouted the requested model")
      }
      if (method !== "turn/completed") return
      if (stringAt(message, ["params", "threadId"]) !== threadId) {
        return fail("app-server completed a mismatched thread")
      }
      const turn = objectAt(message, ["params", "turn"])
      const items = turn === undefined ? undefined : Reflect.get(turn, "items")
      if (
        turn === undefined ||
        Reflect.get(turn, "status") !== "completed" ||
        !Array.isArray(items)
      ) {
        return fail(stringAt(turn, ["error", "message"]) ?? "app-server turn did not complete")
      }
      const output = [...items]
        .reverse()
        .find(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            Reflect.get(item, "type") === "agentMessage",
        )
      const text = stringAt(output, ["text"])
      if (text === undefined) return fail("app-server returned no final agent message")
      finish({
        kind: "output",
        output: text,
        transcriptHash: transcript.digest("hex"),
        transport: "app-server",
        usage: parseUsageEvents(usageLines.join("\n"), threadId),
      })
    }
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return
      capturedBytes += chunk.length
      if (capturedBytes > MAX_CAPTURE_BYTES) return fail("app-server output exceeded limit")
      transcript.update(chunk)
      try {
        buffered += decoder.decode(chunk, { stream: true })
      } catch {
        return fail("app-server emitted invalid UTF-8")
      }
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (line.trim() === "") continue
        try {
          handleMessage(JSON.parse(line))
        } catch {
          fail("app-server emitted malformed JSONL")
          return
        }
      }
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
      if (Buffer.byteLength(stderr) > MAX_CAPTURE_BYTES) fail("app-server stderr exceeded limit")
    })
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        kind: "unverified",
        missingCapability:
          error.code === "ENOENT" ? "codex-cli" : redactCodexDiagnostic(error.message),
      })
    })
    child.once("close", (code) => {
      if (!settled) fail(stderr || `app-server exited before completion (${String(code)})`)
    })
    child.stdin.on("error", () => undefined)
    options.signal?.addEventListener("abort", cancel, { once: true })
    const deadline = setTimeout(
      () => finish({ kind: "unverified", missingCapability: "codex-timeout" }),
      options.timeoutMs,
    )
    write({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "app-development-harness", version: "1" },
        capabilities: { experimentalApi: true },
      },
    })
  })
}
