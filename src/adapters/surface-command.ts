import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { AdapterCommand } from "./official-types"

type SurfaceConfig = {
  readonly executable: string
  readonly args: readonly string[]
  readonly path: string
  readonly expected: string
  readonly format: "bun" | "go-json" | "unittest"
  readonly environment?: Readonly<Record<string, string>>
}

function workerModulePath(): string {
  const current = fileURLToPath(import.meta.url)
  return basename(current) === "cli.js"
    ? join(dirname(current), "surface-qa-worker.js")
    : join(dirname(current), "..", "surface-qa-worker.ts")
}

export function surfaceQaCommand(config: SurfaceConfig): AdapterCommand {
  return {
    executable: process.execPath,
    args: [workerModulePath(), JSON.stringify(config)],
  }
}
