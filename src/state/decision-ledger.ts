import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  DecisionInputSchema,
  type DecisionMutation,
  DecisionMutationSchema,
  type DecisionRecord,
  DecisionRecordSchema,
  type DecisionStatus,
} from "../domain/decision"
import { appendStateFile } from "./atomic-state-file"
import { withFileLock } from "./file-lock"
import { assertSafeStateFile } from "./safe-path"

const MAX_EVENT_BYTES = 64 * 1024
const MAX_LEDGER_BYTES = 5 * 1024 * 1024

export class RevisionConflictError extends Error {
  readonly name = "RevisionConflictError"
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`decision revision conflict: expected ${expected}, actual ${actual}`)
  }
}

export class LedgerIntegrityError extends Error {
  readonly name = "LedgerIntegrityError"
}

export class DecisionTransitionError extends Error {
  readonly name = "DecisionTransitionError"
}

export class IdempotencyConflictError extends Error {
  readonly name = "IdempotencyConflictError"
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function eventHash(record: Omit<DecisionRecord, "eventHash">): string {
  return createHash("sha256").update(canonical(record)).digest("hex")
}

function mutationHash(input: DecisionMutation): string {
  return createHash("sha256").update(canonical(input)).digest("hex")
}

function withoutHash(record: DecisionRecord): Omit<DecisionRecord, "eventHash"> {
  const { eventHash: ignored, ...unsigned } = record
  void ignored
  return unsigned
}

function statusFor(action: DecisionMutation["action"], current: DecisionStatus): DecisionStatus {
  switch (action) {
    case "approve":
      return "approved"
    case "reject":
      return "rejected"
    case "request_revision":
      return "revision_requested"
    case "comment":
      return current
  }
}

export class DecisionLedger {
  readonly projectRoot: string
  readonly file: string
  readonly lock: string

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot)
    this.file = join(this.projectRoot, ".app-harness", "decisions.jsonl")
    this.lock = join(this.projectRoot, ".app-harness", "locks", "decisions.lock")
  }

  async initialize(rawInput: unknown): Promise<DecisionRecord> {
    const input = DecisionInputSchema.parse(rawInput)
    await assertSafeStateFile(this.projectRoot, this.lock)
    return withFileLock(this.projectRoot, this.lock, async () => {
      const records = await this.readRecords()
      if (records.some((record) => record.id === input.id && record.runId === input.runId)) {
        throw new DecisionTransitionError(`decision already exists: ${input.runId}:${input.id}`)
      }
      const unsigned: Omit<DecisionRecord, "eventHash"> = {
        ...input,
        status: "pending",
        selected: null,
        reason: null,
        decidedAt: null,
        revision: 1,
        previousHash: records.at(-1)?.eventHash ?? null,
        idempotencyKey: `initial:${createHash("sha256")
          .update(`${input.runId}:${input.id}`)
          .digest("hex")}`,
      }
      return this.append({ ...unsigned, eventHash: eventHash(unsigned) })
    })
  }

  async mutate(rawInput: unknown): Promise<DecisionRecord> {
    const input = DecisionMutationSchema.parse(rawInput)
    await assertSafeStateFile(this.projectRoot, this.lock)
    return withFileLock(this.projectRoot, this.lock, async () => {
      const records = await this.readRecords()
      const repeated = records.find((record) => record.idempotencyKey === input.idempotencyKey)
      if (repeated !== undefined) {
        if (
          repeated.id === input.id &&
          repeated.runId === input.runId &&
          repeated.mutationHash === mutationHash(input)
        )
          return repeated
        throw new IdempotencyConflictError(
          `idempotency key is bound to another decision mutation: ${input.idempotencyKey}`,
        )
      }
      const head = records
        .filter((record) => record.id === input.id && record.runId === input.runId)
        .at(-1)
      if (head === undefined) {
        throw new DecisionTransitionError(`unknown decision: ${input.runId}:${input.id}`)
      }
      if (head.revision !== input.expectedRevision) {
        throw new RevisionConflictError(input.expectedRevision, head.revision)
      }
      const selected = input.action === "approve" ? input.selected : head.selected
      if (input.action === "approve") {
        if (selected === undefined || !head.alternatives.some((item) => item.id === selected)) {
          throw new DecisionTransitionError("selected must be an advertised alternative")
        }
      }
      const { eventHash: previousEventHash, ...headWithoutHash } = head
      void previousEventHash
      const unsigned: Omit<DecisionRecord, "eventHash"> = {
        ...headWithoutHash,
        status: statusFor(input.action, head.status),
        selected: selected ?? null,
        reason: input.reason,
        actor: input.actor,
        decidedAt: input.decidedAt,
        revision: head.revision + 1,
        previousHash: records.at(-1)?.eventHash ?? null,
        idempotencyKey: input.idempotencyKey,
        action: input.action,
        mutationHash: mutationHash(input),
      }
      return this.append({ ...unsigned, eventHash: eventHash(unsigned) })
    })
  }

  async list(): Promise<readonly DecisionRecord[]> {
    const heads = new Map<string, DecisionRecord>()
    for (const record of await this.readRecords()) heads.set(`${record.runId}:${record.id}`, record)
    return [...heads.values()]
  }

  async listRun(runId: string): Promise<readonly DecisionRecord[]> {
    return (await this.list()).filter((record) => record.runId === runId)
  }

  async history(id: string, runId: string): Promise<readonly DecisionRecord[]> {
    return (await this.readRecords()).filter((record) => record.id === id && record.runId === runId)
  }

  async events(): Promise<readonly DecisionRecord[]> {
    return this.readRecords()
  }

  private async readRecords(): Promise<readonly DecisionRecord[]> {
    await assertSafeStateFile(this.projectRoot, this.file)
    let contents = ""
    try {
      contents = await readFile(this.file, "utf8")
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      ) {
        throw error
      }
    }
    if (Buffer.byteLength(contents) > MAX_LEDGER_BYTES)
      throw new LedgerIntegrityError("ledger too large")
    const lines = contents === "" ? [] : contents.trimEnd().split("\n")
    const records: DecisionRecord[] = []
    let previousHash: string | null = null
    for (const line of lines) {
      if (Buffer.byteLength(line) > MAX_EVENT_BYTES)
        throw new LedgerIntegrityError("event too large")
      const record = DecisionRecordSchema.parse(JSON.parse(line))
      if (
        record.previousHash !== previousHash ||
        eventHash(withoutHash(record)) !== record.eventHash
      ) {
        throw new LedgerIntegrityError("decision ledger integrity failure")
      }
      records.push(record)
      previousHash = record.eventHash
    }
    return records
  }

  private async append(record: DecisionRecord): Promise<DecisionRecord> {
    const line = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new LedgerIntegrityError("event too large")
    await assertSafeStateFile(this.projectRoot, this.file)
    await appendStateFile(this.projectRoot, this.file, line)
    return record
  }
}
