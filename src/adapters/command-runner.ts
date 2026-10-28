import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { delimiter } from "node:path"
import { findUnsafeWritablePath } from "./artifact-writer"
import type { AdapterCommandReceipt, AdapterContext, AdapterResult } from "./contract"
import type { AdapterCommand } from "./official-types"

export type CommandOutcome =
  | { readonly kind: "passed"; readonly stdout: string; readonly exitCode: 0 }
  | { readonly kind: "missing"; readonly stdout: "" }
  | { readonly kind: "unsafe"; readonly path: string; readonly stdout: "" }
  | { readonly kind: "failed"; readonly stdout: string; readonly exitCode: number }

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const value = Reflect.get(error, "code")
  return typeof value === "string" ? value : undefined
}

function exitCode(error: unknown): number {
  if (typeof error !== "object" || error === null || !("code" in error)) return 1
  const value = Reflect.get(error, "code")
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 1
}

export async function runCommand(
  context: AdapterContext,
  command: AdapterCommand,
): Promise<CommandOutcome> {
  const unsafe = await findUnsafeWritablePath(context.projectRoot, command.writablePaths ?? [])
  if (unsafe !== undefined) return { kind: "unsafe", path: unsafe, stdout: "" }
  const configuredPath = context.toolchainPath
  const environmentPath = Reflect.get(process.env, "PATH")
  const inheritedPath = typeof environmentPath === "string" ? environmentPath : ""
  const path =
    configuredPath === undefined ? inheritedPath : `${configuredPath}${delimiter}${inheritedPath}`
  const environment = { ...context.executionEnvironment, PATH: path }
  return new Promise((resolve) => {
    execFile(
      command.executable,
      [...command.args],
      {
        cwd: context.projectRoot,
        encoding: "utf8",
        env: environment,
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr === "" ? "" : `\n${stderr}`}`
        if (error === null) resolve({ kind: "passed", stdout: output, exitCode: 0 })
        else if (errorCode(error) === "ENOENT") resolve({ kind: "missing", stdout: "" })
        else resolve({ kind: "failed", stdout: output, exitCode: exitCode(error) })
      },
    )
  })
}

export function commandResult(
  outcome: CommandOutcome,
  stage: string,
  command: AdapterCommand,
): AdapterResult {
  const commands = [command]
  const receipt: AdapterCommandReceipt = {
    executable: command.executable,
    args: command.args,
    outcome: outcome.kind,
    exitCode: outcome.kind === "passed" || outcome.kind === "failed" ? outcome.exitCode : null,
    stdoutHash: createHash("sha256").update(outcome.stdout).digest("hex"),
  }
  const commandReceipts = [receipt]
  switch (outcome.kind) {
    case "passed":
      return { status: "passed", summary: `${stage} passed`, commands, commandReceipts }
    case "missing":
      return {
        status: "unverified",
        summary: `missing_toolchain: ${command.executable}; ${stage} not verified`,
        commands,
        commandReceipts,
      }
    case "unsafe":
      return {
        status: "blocked",
        summary: `unsafe_command_path: ${outcome.path}; ${stage}`,
        commands,
        commandReceipts,
      }
    case "failed":
      return {
        status: "blocked",
        summary: `command_failed: ${command.executable}; ${stage}`,
        commands,
        commandReceipts,
      }
  }
}
