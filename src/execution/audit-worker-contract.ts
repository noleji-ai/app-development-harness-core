import { z } from "zod"

const ShaSchema = z.string().regex(/^[a-f0-9]{64}$/)
const ArtifactSchema = z
  .object({ path: z.string().min(1), sha256: ShaSchema, size: z.number().int().positive() })
  .strict()
const FileSchema = z
  .object({ path: z.string().min(1), sha256: ShaSchema, size: z.number().int().nonnegative() })
  .strict()
const CommandArgumentSchema = z
  .string()
  .refine(
    (value) => !/postgres(?:ql)?:\/\//iu.test(value),
    "database URLs must be redacted from audit evidence",
  )
const CommandReceiptSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(CommandArgumentSchema),
    outcome: z.literal("passed"),
    exitCode: z.literal(0),
    stdoutHash: ShaSchema,
  })
  .strict()

export const INTERNAL_AUDIT_KINDS = [
  "accessibility",
  "security",
  "migrations",
  "backup_restore",
  "toolchain",
] as const

export const AuditWorkerInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    adapterId: z.string().min(1),
    kind: z.enum(INTERNAL_AUDIT_KINDS),
    outputArtifacts: z.array(ArtifactSchema).max(10),
  })
  .strict()

const BaseShape = {
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  adapterId: z.string().min(1),
  status: z.literal("passed"),
} as const

const AccessibilityReportSchema = z
  .object({
    ...BaseShape,
    kind: z.literal("accessibility"),
    applicable: z.boolean(),
    checks: z.number().int().nonnegative(),
    rules: z.array(z.string().min(1)),
  })
  .strict()
const SecurityReportSchema = z
  .object({
    ...BaseShape,
    kind: z.literal("security"),
    filesScanned: z.number().int().positive(),
    fileHashes: z.array(FileSchema).min(1),
    outputArtifacts: z.array(ArtifactSchema),
    findings: z.array(z.string()),
  })
  .strict()
const MigrationApplicationSchema = z.discriminatedUnion("applicable", [
  z
    .object({
      applicable: z.literal(true),
      engine: z.literal("sqlite-disposable-postgres-compatibility-projection"),
      migrationsApplied: z.number().int().positive(),
      statementsApplied: z.number().int().positive(),
      idempotentReplay: z.literal(true),
      integrity: z.literal("ok"),
      tables: z.array(z.string().min(1)).min(1),
      commandReceipt: CommandReceiptSchema,
    })
    .strict(),
  z
    .object({
      applicable: z.literal(false),
      verifiedNotApplicable: z.literal(true),
      rationale: z.string().min(1),
    })
    .strict(),
])
const MigrationReportSchema = z
  .object({
    ...BaseShape,
    kind: z.literal("migrations"),
    applicable: z.boolean(),
    migrations: z.array(FileSchema),
    application: MigrationApplicationSchema,
  })
  .strict()
const BackupDetailsSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("stateless"),
      filesScanned: z.number().int().positive(),
      indicators: z.array(z.string()).length(0),
      proofSha256: ShaSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("stateful"),
      contract: z.literal("postgresql"),
      bytes: z.number().int().positive(),
      snapshotSha256: ShaSchema,
      originalSha256: ShaSchema,
      mutatedSha256: ShaSchema,
      restoredSha256: ShaSchema,
      matched: z.literal(true),
      commandReceipts: z.array(CommandReceiptSchema).length(6),
    })
    .strict(),
])
const BackupReportSchema = z
  .object({
    ...BaseShape,
    kind: z.literal("backup_restore"),
    details: BackupDetailsSchema,
  })
  .strict()
const ToolchainReportSchema = z
  .object({
    ...BaseShape,
    kind: z.literal("toolchain"),
    expected: z.string().min(1).nullable(),
    observed: z.string().min(1),
    commandReceipt: CommandReceiptSchema,
  })
  .strict()

export const AuditWorkerReportSchema = z.discriminatedUnion("kind", [
  AccessibilityReportSchema,
  SecurityReportSchema,
  MigrationReportSchema,
  BackupReportSchema,
  ToolchainReportSchema,
])

export type InternalAuditKind = (typeof INTERNAL_AUDIT_KINDS)[number]
export type AuditWorkerInput = z.infer<typeof AuditWorkerInputSchema>
export type AuditWorkerReport = z.infer<typeof AuditWorkerReportSchema>
