import type { AppAdapter } from "../adapters/contract"
import type { PipelineStage, RunManifest } from "../domain/manifest.js"
import type { StageResult } from "../engine/pipeline.js"

export const PUBLIC_COMMANDS = [
  "init",
  "run",
  "resume",
  "status",
  "verify",
  "dashboard",
  "doctor",
  "upgrade",
] as const

export type PublicCommand = (typeof PUBLIC_COMMANDS)[number]

export const CLI_HELP = `Usage: app-harness <command> [options]

Run: app-harness run --project <path> (--request <text> | --request-file <contained-path>)

Commands:
${PUBLIC_COMMANDS.map((command) => `  ${command}`).join("\n")}`

export class CliUsageError extends Error {
  override readonly name: string = "CliUsageError"
}

export interface CliIo {
  stdout(value: string): void
  stderr(value: string): void
}

export interface CliServices {
  executeStage?(stage: PipelineStage, manifest: Readonly<RunManifest>): Promise<StageResult>
  dashboard?(projectRoot: string, open: boolean): Promise<{ url?: string; snapshot: string }>
  readonly codexBinary?: string
  readonly codexTransport?: "exec" | "app-server"
  readonly codexAppServerSocket?: string
  readonly codexTimeoutMs?: number
  readonly adapters?: readonly AppAdapter[]
  readonly adapterToolchainPath?: string
  readonly adapterExecutionEnvironment?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  now?(): string
  runId?(): string
}

export function isPublicCommand(value: string | undefined): value is PublicCommand {
  return PUBLIC_COMMANDS.some((command) => command === value)
}
