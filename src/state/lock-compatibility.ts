import { constants } from "node:fs"
import { open, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

import { assertSafeStateDirectory, assertSafeStateFile } from "./safe-path"

export const LOCK_PROTOCOL_VERSION = 2
export const HARNESS_LOCK_SCHEMA_VERSION = 2

const TechnologiesSchema = z.record(z.string(), z.unknown())

const LegacyHarnessLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    harnessVersion: z.string().min(1),
    registryVersion: z.string().min(1),
    technologies: TechnologiesSchema,
  })
  .strict()

export const HarnessLockSchema = z
  .object({
    schemaVersion: z.literal(HARNESS_LOCK_SCHEMA_VERSION),
    harnessVersion: z.string().min(1),
    registryVersion: z.string().min(1),
    lockProtocolVersion: z.literal(LOCK_PROTOCOL_VERSION),
    technologies: TechnologiesSchema,
  })
  .strict()

const FenceSchema = z
  .object({
    kind: z.literal("app-harness-lock-fence"),
    protocolVersion: z.number().int().positive(),
    pid: z.literal(1),
    createdAt: z.iso.datetime(),
    token: z.string().min(1),
  })
  .strict()

const FenceMarkerSchema = z.object({ kind: z.literal("app-harness-lock-fence") }).passthrough()

const LegacyLockSchema = z
  .object({
    pid: z.number().int().positive(),
    createdAt: z.iso.datetime(),
  })
  .passthrough()

export type HarnessLock = z.infer<typeof HarnessLockSchema>
export type LockProtocolStatus =
  | "compatible"
  | "upgrade-required"
  | "active-legacy-lock"
  | "recovery-required"
  | "unsupported-protocol"

export type LockProtocolBlocker = {
  readonly name: string
  readonly status: Exclude<LockProtocolStatus, "compatible" | "upgrade-required">
  readonly remediation: string
}

export type LockProtocolHealth = {
  readonly version: typeof LOCK_PROTOCOL_VERSION
  readonly status: LockProtocolStatus
  readonly metadata: "compatible" | "upgrade-required" | "invalid"
  readonly fences: number
  readonly blockers: readonly LockProtocolBlocker[]
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const value = Reflect.get(error, "code")
  return typeof value === "string" ? value : undefined
}

function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false
    if (errorCode(error) === "EPERM") return true
    throw error
  }
}

async function inspectBaseLock(
  path: string,
  name: string,
): Promise<LockProtocolBlocker | undefined> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    if (errorCode(error) === "ENOENT") return undefined
    return {
      name,
      status: "recovery-required",
      remediation: "Unsafe lock path; stop all harness processes and inspect it manually.",
    }
  }
  try {
    const state = await handle.stat()
    if (!state.isFile() || state.nlink !== 1) {
      return {
        name,
        status: "recovery-required",
        remediation: "Unsafe lock identity; stop all harness processes and inspect it manually.",
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await handle.readFile("utf8"))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      parsed = undefined
    }
    const fence = FenceSchema.safeParse(parsed)
    if (fence.success) {
      return fence.data.protocolVersion === LOCK_PROTOCOL_VERSION
        ? undefined
        : {
            name,
            status: "unsupported-protocol",
            remediation: "Use a harness version that supports this lock protocol.",
          }
    }
    if (FenceMarkerSchema.safeParse(parsed).success) {
      return {
        name,
        status: "recovery-required",
        remediation: "Invalid protocol fence; stop all harness processes and inspect it manually.",
      }
    }
    const legacy = LegacyLockSchema.safeParse(parsed)
    if (legacy.success && ownerIsAlive(legacy.data.pid)) {
      return {
        name,
        status: "active-legacy-lock",
        remediation: "Retry after the previous harness process releases this lock.",
      }
    }
    if (!legacy.success && state.mtimeMs >= Date.now() - 300_000) {
      return {
        name,
        status: "active-legacy-lock",
        remediation: "Retry after the previous harness finishes initializing its lock.",
      }
    }
    return {
      name,
      status: "recovery-required",
      remediation:
        "Automatic removal is unsafe. Stop every harness process, quarantine this file, then rerun doctor.",
    }
  } finally {
    await handle.close()
  }
}

export async function readHarnessLock(projectRoot: string, stateRoot: string): Promise<unknown> {
  const path = join(stateRoot, "harness.lock.json")
  await assertSafeStateFile(projectRoot, path)
  return JSON.parse(await readFile(path, "utf8"))
}

export function upgradeHarnessLock(value: unknown, harnessVersion: string): HarnessLock {
  const current = HarnessLockSchema.safeParse(value)
  if (current.success) return { ...current.data, harnessVersion }
  const legacy = LegacyHarnessLockSchema.parse(value)
  return {
    schemaVersion: HARNESS_LOCK_SCHEMA_VERSION,
    harnessVersion,
    registryVersion: legacy.registryVersion,
    lockProtocolVersion: LOCK_PROTOCOL_VERSION,
    technologies: legacy.technologies,
  }
}

export async function inspectLockProtocol(
  projectRoot: string,
  stateRoot: string,
): Promise<LockProtocolHealth> {
  let metadataValue: unknown
  try {
    metadataValue = await readHarnessLock(projectRoot, stateRoot)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    metadataValue = undefined
  }
  const metadata = HarnessLockSchema.safeParse(metadataValue).success
    ? "compatible"
    : LegacyHarnessLockSchema.safeParse(metadataValue).success
      ? "upgrade-required"
      : "invalid"
  const lockRoot = join(stateRoot, "locks")
  await assertSafeStateDirectory(projectRoot, lockRoot)
  const names = (await readdir(lockRoot)).filter(
    (name) => !name.startsWith(".") && name.endsWith(".lock"),
  )
  const inspected = await Promise.all(
    names.map((name) => inspectBaseLock(join(lockRoot, name), name)),
  )
  const baseBlockers = inspected.filter((item): item is LockProtocolBlocker => item !== undefined)
  const blockers: readonly LockProtocolBlocker[] =
    metadata === "invalid"
      ? [
          {
            name: "harness.lock.json",
            status: "recovery-required",
            remediation: "Restore valid compatibility metadata before upgrading.",
          },
          ...baseBlockers,
        ]
      : baseBlockers
  const fences = names.length - baseBlockers.length
  const status = blockers.some((item) => item.status === "unsupported-protocol")
    ? "unsupported-protocol"
    : blockers.some((item) => item.status === "recovery-required") || metadata === "invalid"
      ? "recovery-required"
      : blockers.some((item) => item.status === "active-legacy-lock")
        ? "active-legacy-lock"
        : metadata === "upgrade-required"
          ? "upgrade-required"
          : "compatible"
  return { version: LOCK_PROTOCOL_VERSION, status, metadata, fences, blockers }
}
