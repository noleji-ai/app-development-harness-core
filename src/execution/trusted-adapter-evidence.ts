import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"

import type { AdapterResult, AppAdapter } from "../adapters/contract"
import type { RunManifest } from "../domain/manifest"
import { type VerificationCheck, VerificationCheckSchema } from "../release/readiness"
import { atomicWriteStateFile } from "../state/atomic-state-file"
import type { ProjectStore } from "../state/project-store"
import { validateTrustedResult } from "./trusted-result-validator"

const OperationSchema = z.enum(["build", "test", "manualQa", "packageDeployReady", "security"])
const ReleaseSecuritySchema = z
  .object({ adapterId: z.string(), providerNeutral: z.boolean(), signed: z.boolean() })
  .passthrough()
const ExitReceiptSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()),
    outcome: z.enum(["passed", "failed", "missing", "unsafe"]),
    exitCode: z.number().int().nullable(),
    stdoutHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
const ReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    adapterId: z.string().min(1),
    adapterVersion: z.string().min(1),
    operation: OperationSchema,
    status: z.enum(["passed", "blocked", "unverified"]),
    commandsHash: z.string().length(64),
    exitReceiptsHash: z.string().length(64),
    exitReceipts: z.array(ExitReceiptSchema).min(1),
    artifactHashes: z.array(z.string().length(64)),
    receiptHash: z.string().length(64),
  })
  .strict()

export type TrustedReceipt = z.infer<typeof ReceiptSchema>

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function trustedDigest(value: unknown): string {
  const input = typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)
  return createHash("sha256").update(input).digest("hex")
}

export function createReceipt(
  manifest: Readonly<RunManifest>,
  adapter: AppAdapter,
  operation: z.infer<typeof OperationSchema>,
  result: AdapterResult,
  artifactHashes: readonly string[] = [],
): TrustedReceipt {
  const commandReceipts = validateTrustedResult(adapter, operation, result)
  const outputs = result.outputArtifacts?.map((artifact) => artifact.sha256) ?? []
  const base = {
    schemaVersion: 1 as const,
    runId: manifest.runId,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    operation,
    status: result.status,
    commandsHash: trustedDigest(result.commands),
    exitReceiptsHash: trustedDigest(commandReceipts),
    exitReceipts: commandReceipts.map((receipt) => ({ ...receipt, args: [...receipt.args] })),
    artifactHashes: [...new Set([...artifactHashes, ...outputs])],
  }
  return ReceiptSchema.parse({ ...base, receiptHash: trustedDigest(base) })
}

export async function releaseArtifactHash(root: string, adapterId: string): Promise<string> {
  const path = resolve(root, ".app-harness", "releases", adapterId, "manifest.json")
  const route = relative(resolve(root), path)
  if (route === ".." || route.startsWith(`..${sep}`) || isAbsolute(adapterId)) {
    throw new Error("unsafe release artifact")
  }
  const state = await lstat(path)
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    throw new Error("release artifact is not a trusted regular file")
  }
  return trustedDigest(await readFile(path))
}

export function readinessCheck(id: string, receipt: TrustedReceipt): VerificationCheck {
  return {
    id,
    required: true,
    status: receipt.status === "passed" ? "passed" : receipt.status,
    evidenceIds: [`adapter-receipt:${receipt.runId}:${receipt.operation}:${receipt.receiptHash}`],
  }
}

export function validateTrustedEvidence(
  receipts: readonly unknown[],
  checks: readonly unknown[],
): { receipts: TrustedReceipt[]; checks: VerificationCheck[] } {
  const parsedReceipts = receipts.map((receipt) => ReceiptSchema.parse(receipt))
  const parsed = checks.map((check) => VerificationCheckSchema.parse(check))
  if (parsedReceipts.length === 0 && parsed.length === 0) return { receipts: [], checks: [] }
  if (new Set(parsedReceipts.map((item) => item.operation)).size !== parsedReceipts.length) {
    throw new Error("duplicate trusted adapter receipts")
  }
  const identities = new Set(parsedReceipts.map((item) => `${item.runId}:${item.adapterId}`))
  if (identities.size !== 1) throw new Error("trusted adapter receipts have mixed identities")
  for (const receipt of parsedReceipts) {
    const { receiptHash, ...base } = receipt
    if (trustedDigest(base) !== receiptHash)
      throw new Error("trusted adapter receipt hash mismatch")
    if (
      receipt.status === "passed" &&
      (receipt.operation === "packageDeployReady" || receipt.operation === "security") &&
      receipt.artifactHashes.length === 0
    ) {
      throw new Error("trusted release receipt lacks an artifact hash")
    }
  }
  const ids = new Set(parsed.map((check) => check.id))
  if (ids.size !== parsed.length) throw new Error("duplicate trusted readiness checks")
  const allowed = ["build", "test", "manual-qa", "security", "release-bundle"]
  const unknown = [...ids].find((id) => !allowed.includes(id))
  if (unknown !== undefined) throw new Error(`unknown trusted readiness check: ${unknown}`)
  const expectedChecks = new Map(
    parsedReceipts.map((receipt) => [
      receipt.operation === "manualQa"
        ? "manual-qa"
        : receipt.operation === "packageDeployReady"
          ? "release-bundle"
          : receipt.operation,
      receipt,
    ]),
  )
  if (expectedChecks.size !== parsed.length)
    throw new Error("trusted readiness check set is incomplete")
  for (const check of parsed) {
    const receipt = expectedChecks.get(check.id)
    const evidence =
      receipt === undefined
        ? undefined
        : `adapter-receipt:${receipt.runId}:${receipt.operation}:${receipt.receiptHash}`
    const expectedStatus = receipt?.status === "passed" ? "passed" : receipt?.status
    if (
      evidence === undefined ||
      check.evidenceIds.length !== 1 ||
      check.evidenceIds[0] !== evidence ||
      !check.required ||
      check.status !== expectedStatus
    ) {
      throw new Error(`untrusted readiness evidence: ${check.id}`)
    }
  }
  return { receipts: parsedReceipts, checks: parsed }
}

export async function persistTrustedEvidence(
  store: ProjectStore,
  receipts: readonly TrustedReceipt[],
  checks: readonly VerificationCheck[],
): Promise<void> {
  const parsed = validateTrustedEvidence(receipts, checks)
  await Promise.all([
    atomicWriteStateFile(
      store.projectRoot,
      join(store.stateRoot, "evidence/adapter-receipts.jsonl"),
      `${parsed.receipts.map((item) => JSON.stringify(item)).join("\n")}\n`,
    ),
    atomicWriteStateFile(
      store.projectRoot,
      join(store.stateRoot, "evidence/index.jsonl"),
      `${parsed.checks.map((check) => JSON.stringify(check)).join("\n")}\n`,
    ),
  ])
}

export async function createSecurityReceipt(
  manifest: Readonly<RunManifest>,
  adapter: AppAdapter,
  packageReceipt: TrustedReceipt,
  root: string,
): Promise<TrustedReceipt> {
  const path = join(root, ".app-harness", "releases", adapter.id, "manifest.json")
  const value = ReleaseSecuritySchema.parse(JSON.parse(await readFile(path, "utf8")))
  const safe =
    value.adapterId === adapter.id &&
    value.providerNeutral === true &&
    value.signed === false &&
    !/(?:api[_-]?key|bearer\s+|\bdeploy\b|\bpublish\b|dns)/i.test(JSON.stringify(value))
  const base = {
    schemaVersion: 1 as const,
    runId: manifest.runId,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    operation: "security" as const,
    status: safe ? ("passed" as const) : ("blocked" as const),
    commandsHash: packageReceipt.commandsHash,
    exitReceiptsHash: packageReceipt.exitReceiptsHash,
    exitReceipts: packageReceipt.exitReceipts,
    artifactHashes: packageReceipt.artifactHashes,
  }
  return ReceiptSchema.parse({ ...base, receiptHash: trustedDigest(base) })
}
