#!/usr/bin/env node

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { executeCli } from "./cli/commands"
import { closeBoundStateWorkers } from "./state/bound-state-directory"

export { executeCli } from "./cli/commands"
export type { CliIo, CliServices, PublicCommand } from "./cli/contracts"
export { CLI_HELP, CliUsageError, PUBLIC_COMMANDS } from "./cli/contracts"

async function main(): Promise<void> {
  const controller = new AbortController()
  let interrupted = false
  const interrupt = () => {
    interrupted = true
    controller.abort()
  }
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    let args = process.argv.slice(2)
    if (args[0] === "hook" && args[1] === "user-prompt-submit" && args.length === 2) {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
      args = [...args, Buffer.concat(chunks).toString("utf8")]
    }
    await executeCli(args, undefined, { signal: controller.signal })
    if (interrupted) process.exitCode = 130
  } finally {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
    await closeBoundStateWorkers()
  }
}

export function isDirectInvocation(invokedPath: string | undefined, moduleUrl: string): boolean {
  if (invokedPath === undefined) return false
  return realpathSync(invokedPath) === realpathSync(fileURLToPath(moduleUrl))
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  // no-excuse-ok: catch — CLI process boundary converts unknown failures to stderr and exit status.
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
