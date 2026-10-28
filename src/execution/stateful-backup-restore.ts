import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import { runCommand } from "../adapters/command-runner"
import type { AdapterCommandReceipt, AdapterContext } from "../adapters/contract"
import type { AdapterCommand, AdapterPersistence } from "../adapters/official-types"

type PostgresPersistence = Extract<AdapterPersistence, { readonly kind: "postgresql" }>

type ExecutedCommand = {
  readonly stdout: string
  readonly receipt: AdapterCommandReceipt & { readonly outcome: "passed"; readonly exitCode: 0 }
}

function contained(root: string, target: string): boolean {
  const route = relative(root, target)
  return route !== "" && route !== ".." && !route.startsWith(`..${sep}`)
}

function configured(name: string): string | undefined {
  const value = Reflect.get(process.env, name)
  return typeof value === "string" ? value : undefined
}

function expand(command: AdapterCommand, databaseUrl: string): AdapterCommand {
  return {
    ...command,
    args: command.args.map((argument) => argument.replace("{databaseUrl}", databaseUrl)),
  }
}

function redactedArguments(args: readonly string[], databaseUrl: string): readonly string[] {
  return args.map((argument) => argument.split(databaseUrl).join("[REDACTED_DATABASE_URL]"))
}

async function execute(
  context: AdapterContext,
  command: AdapterCommand,
  databaseUrl: string,
): Promise<ExecutedCommand> {
  const outcome = await runCommand(context, command)
  if (outcome.kind !== "passed") {
    throw new Error(`backup restore command failed: ${command.executable} (${outcome.kind})`)
  }
  return {
    stdout: outcome.stdout,
    receipt: {
      executable: command.executable,
      args: redactedArguments(command.args, databaseUrl),
      outcome: "passed",
      exitCode: 0,
      stdoutHash: createHash("sha256").update(outcome.stdout).digest("hex"),
    },
  }
}

function stateHash(value: string): string {
  if (value.trim() === "") throw new Error("backup restore state observation was empty")
  return createHash("sha256").update(value.trim()).digest("hex")
}

export async function postgresqlBackupRestoreAudit(
  projectRoot: string,
  persistence: PostgresPersistence,
): Promise<{
  readonly mode: "stateful"
  readonly contract: "postgresql"
  readonly bytes: number
  readonly snapshotSha256: string
  readonly originalSha256: string
  readonly mutatedSha256: string
  readonly restoredSha256: string
  readonly matched: true
  readonly commandReceipts: readonly AdapterCommandReceipt[]
}> {
  const databaseUrl = configured(persistence.databaseUrlEnvironment)
  const disposable = configured(persistence.disposableEnvironment)
  if (
    databaseUrl === undefined ||
    !/^postgres(?:ql)?:\/\//.test(databaseUrl) ||
    databaseUrl.includes("\0") ||
    databaseUrl.length > 2048 ||
    disposable !== "yes"
  ) {
    throw new Error(
      `stateful backup restore requires ${persistence.databaseUrlEnvironment} and ${persistence.disposableEnvironment}=yes`,
    )
  }
  const context: AdapterContext = {
    projectRoot,
    mode: "create",
    requestedCapabilities: [],
    executionEnvironment: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  }
  const commands = {
    observe: expand(persistence.observe, databaseUrl),
    backup: expand(persistence.backup, databaseUrl),
    mutate: expand(persistence.mutate, databaseUrl),
    restore: expand(persistence.restore, databaseUrl),
  }
  const before = await execute(context, commands.observe, databaseUrl)
  const backup = await execute(context, commands.backup, databaseUrl)
  const mutation = await execute(context, commands.mutate, databaseUrl)
  const mutated = await execute(context, commands.observe, databaseUrl)
  const originalSha256 = stateHash(before.stdout)
  const mutatedSha256 = stateHash(mutated.stdout)
  if (originalSha256 === mutatedSha256) throw new Error("backup restore mutation changed no state")
  const restore = await execute(context, commands.restore, databaseUrl)
  const restored = await execute(context, commands.observe, databaseUrl)
  const restoredSha256 = stateHash(restored.stdout)
  if (originalSha256 !== restoredSha256) throw new Error("backup restore roundtrip mismatch")

  const snapshotRoute = persistence.backup.writablePaths?.[0]
  if (snapshotRoute === undefined) throw new Error("backup restore contract has no snapshot path")
  const root = await realpath(resolve(projectRoot))
  const snapshotPath = resolve(root, snapshotRoute)
  if (!contained(root, snapshotPath) || (await realpath(snapshotPath)) !== snapshotPath) {
    throw new Error("backup restore snapshot escaped project")
  }
  const state = await lstat(snapshotPath)
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size === 0) {
    throw new Error("backup restore snapshot is unsafe or empty")
  }
  const snapshot = await readFile(join(root, snapshotRoute))
  return {
    mode: "stateful",
    contract: "postgresql",
    bytes: snapshot.byteLength,
    snapshotSha256: createHash("sha256").update(snapshot).digest("hex"),
    originalSha256,
    mutatedSha256,
    restoredSha256,
    matched: true,
    commandReceipts: [
      before.receipt,
      backup.receipt,
      mutation.receipt,
      mutated.receipt,
      restore.receipt,
      restored.receipt,
    ],
  }
}
