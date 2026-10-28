import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"

import { atomicWriteStateFile } from "../state/atomic-state-file"
import { createBoundStateDirectory } from "../state/bound-state-directory"
import type { ProjectStore } from "../state/project-store"
import { assertSafeStateDirectory, assertSafeStateFile } from "../state/safe-path"

export const RUNNER_RECEIPT_PREFIX = "APP_HARNESS_ADAPTER_RECEIPT\t"
export const RUNNER_EVIDENCE_KINDS = [
  "production_build",
  "unit_integration_tests",
  "manual_surface_qa",
  "accessibility",
  "security",
  "migrations",
  "backup_restore",
  "release_bundle",
  "toolchain",
] as const

const ArtifactSchema = z
  .object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
const ArgSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (value.includes("\0") || Array.from(value).length > 1024) {
      context.addIssue({ code: "custom", message: "invalid runner receipt argv" })
    }
  })
const ReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapterId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    kind: z.enum(RUNNER_EVIDENCE_KINDS),
    argv: z.array(ArgSchema).min(1).max(32),
    outcome: z.literal("passed"),
    exitCode: z.number().int().min(0).max(255),
    stdoutHash: z.string().regex(/^[a-f0-9]{64}$/),
    artifacts: z.array(ArtifactSchema).min(1).max(10),
  })
  .strict()

export type RunnerEvidenceKind = (typeof RUNNER_EVIDENCE_KINDS)[number]
export type RunnerAdapterReceipt = z.infer<typeof ReceiptSchema>
type RunnerEvidenceBase = {
  readonly kind: RunnerEvidenceKind
  readonly argv: readonly string[]
  readonly outcome: "passed"
  readonly exitCode: number
  readonly stdoutHash: string
}
export type RunnerEvidenceDefinition = RunnerEvidenceBase &
  (
    | { readonly report: Readonly<Record<string, unknown>>; readonly reportPath?: never }
    | { readonly reportPath: string; readonly report?: never }
  )

function digest(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
}

function contained(root: string, target: string): boolean {
  const route = relative(root, target)
  return route !== "" && route !== ".." && !route.startsWith(`..${sep}`)
}

function receiptFile(store: ProjectStore): string {
  return join(store.stateRoot, "evidence", "runner-adapter-receipts.jsonl")
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

async function ensureEvidenceRoot(store: ProjectStore, path: string): Promise<void> {
  try {
    await assertSafeStateDirectory(store.projectRoot, path)
    return
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }
  try {
    await createBoundStateDirectory(store.projectRoot, path)
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error
  }
  await assertSafeStateDirectory(store.projectRoot, path)
}

async function verifyArtifact(store: ProjectStore, artifact: z.infer<typeof ArtifactSchema>) {
  if (isAbsolute(artifact.path) || artifact.path.includes("\0")) {
    throw new Error("runner evidence artifact path is unsafe")
  }
  const evidenceRoot = join(store.stateRoot, "adapter-evidence")
  const path = resolve(store.projectRoot, artifact.path)
  const canonicalRoot = await realpath(evidenceRoot)
  const state = await lstat(path)
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    state.size > 10 * 1024 * 1024
  ) {
    throw new Error("runner evidence artifact is not a trusted regular file")
  }
  const canonical = await realpath(path)
  if (!contained(canonicalRoot, canonical)) throw new Error("runner evidence artifact escaped")
  const contents = await readFile(path)
  if (digest(contents) !== artifact.sha256)
    throw new Error("runner evidence artifact hash mismatch")
}

function validateSet(receipts: readonly RunnerAdapterReceipt[]): void {
  if (receipts.length !== RUNNER_EVIDENCE_KINDS.length) {
    throw new Error("runner adapter receipt set is incomplete")
  }
  if (new Set(receipts.map((item) => item.adapterId)).size !== 1) {
    throw new Error("runner adapter receipts have mixed identities")
  }
  const kinds = new Set(receipts.map((item) => item.kind))
  if (kinds.size !== RUNNER_EVIDENCE_KINDS.length) {
    throw new Error("runner adapter receipts have duplicate kinds")
  }
  for (const kind of RUNNER_EVIDENCE_KINDS) {
    if (!kinds.has(kind)) throw new Error(`runner adapter receipt is missing ${kind}`)
  }
}

export async function persistRunnerAdapterReceipts(
  store: ProjectStore,
  adapterId: string,
  definitions: readonly RunnerEvidenceDefinition[],
): Promise<RunnerAdapterReceipt[]> {
  const evidenceRoot = join(store.stateRoot, "adapter-evidence")
  await ensureEvidenceRoot(store, evidenceRoot)
  const receipts: RunnerAdapterReceipt[] = []
  for (const definition of definitions) {
    const path = join(store.stateRoot, "adapter-evidence", `${definition.kind}.json`)
    let contents: string
    if (definition.reportPath === undefined) {
      contents = `${JSON.stringify(definition.report, null, 2)}\n`
      await atomicWriteStateFile(store.projectRoot, path, contents)
    } else {
      const supplied = resolve(store.projectRoot, definition.reportPath)
      if (supplied !== resolve(path))
        throw new Error("runner evidence report path is not correlated")
      await assertSafeStateFile(store.projectRoot, supplied)
      contents = await readFile(supplied, "utf8")
    }
    if (contents.length <= 3) throw new Error("runner evidence report is empty")
    if (definition.outcome !== "passed" || definition.exitCode !== 0) {
      throw new Error("runner evidence command did not pass")
    }
    const route = relative(store.projectRoot, path).split(sep).join("/")
    receipts.push(
      ReceiptSchema.parse({
        schemaVersion: 1,
        adapterId,
        kind: definition.kind,
        argv: [...definition.argv],
        outcome: definition.outcome,
        exitCode: definition.exitCode,
        stdoutHash: definition.stdoutHash,
        artifacts: [{ path: route, sha256: digest(contents) }],
      }),
    )
  }
  validateSet(receipts)
  await atomicWriteStateFile(
    store.projectRoot,
    receiptFile(store),
    `${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`,
  )
  return receipts
}

export async function readRunnerAdapterReceipts(
  store: ProjectStore,
): Promise<RunnerAdapterReceipt[]> {
  const path = receiptFile(store)
  await assertSafeStateFile(store.projectRoot, path)
  const receipts = (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => ReceiptSchema.parse(JSON.parse(line)))
  validateSet(receipts)
  for (const receipt of receipts) {
    if (receipt.exitCode !== 0) throw new Error("persisted runner receipt is not successful")
    for (const artifact of receipt.artifacts) await verifyArtifact(store, artifact)
  }
  return receipts
}

export async function runnerReceiptLines(store: ProjectStore): Promise<string[]> {
  return (await readRunnerAdapterReceipts(store)).map(
    (receipt) => `${RUNNER_RECEIPT_PREFIX}${JSON.stringify(receipt)}`,
  )
}
