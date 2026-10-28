import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { AdapterCommandReceipt } from "../adapters/contract"
import type { AuditedFile } from "./adapter-audit"

type ApplicationAudit = {
  readonly applicable: true
  readonly engine: "sqlite-disposable-postgres-compatibility-projection"
  readonly migrationsApplied: number
  readonly statementsApplied: number
  readonly idempotentReplay: true
  readonly integrity: "ok"
  readonly tables: readonly string[]
}

function postgresCompatibilityProjection(sql: string): string {
  return sql
    .replace(
      /BIGINT\s+GENERATED\s+ALWAYS\s+AS\s+IDENTITY\s+PRIMARY\s+KEY/gi,
      "INTEGER PRIMARY KEY AUTOINCREMENT",
    )
    .replace(/TIMESTAMPTZ/gi, "TEXT")
    .replace(/NOW\(\)/gi, "CURRENT_TIMESTAMP")
}

function statements(sql: string): string[] {
  const values = sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
  if (
    values.length === 0 ||
    values.some(
      (value) => !/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+[a-z_][a-z0-9_]*\s*\(/i.test(value),
    )
  ) {
    throw new Error("migration apply audit rejected unsupported or empty SQL")
  }
  return values
}

async function sqliteApply(
  database: string,
  sql: string,
): Promise<{ readonly output: string; readonly receipt: AdapterCommandReceipt }> {
  const executable = "sqlite3"
  const args = [database] as const
  const environmentPath = Reflect.get(process.env, "PATH")
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(executable, [...args], {
      env: { PATH: typeof environmentPath === "string" ? environmentPath : "/usr/bin:/bin" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", reject)
    child.once("close", (exitCode) => {
      const text = `${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`
      if (exitCode === 0) resolveOutput(text)
      else reject(new Error(`sqlite migration apply failed (${String(exitCode)}): ${text}`))
    })
    child.stdin.end(sql)
  })
  return {
    output,
    receipt: {
      executable,
      args,
      outcome: "passed",
      exitCode: 0,
      stdoutHash: createHash("sha256").update(output).digest("hex"),
    },
  }
}

export async function migrationApplyAudit(
  projectRoot: string,
  migrations: readonly AuditedFile[],
): Promise<
  { readonly audit: ApplicationAudit; readonly receipt: AdapterCommandReceipt } | undefined
> {
  if (migrations.length === 0) return undefined
  const root = await realpath(resolve(projectRoot))
  const projected: string[] = []
  let statementCount = 0
  for (const migration of migrations) {
    const sql = postgresCompatibilityProjection(await readFile(join(root, migration.path), "utf8"))
    const parsed = statements(sql)
    statementCount += parsed.length
    projected.push(...parsed)
  }
  const directory = await mkdtemp(join(tmpdir(), "app-harness-migration-apply-"))
  try {
    const database = join(directory, "schema.sqlite3")
    const transaction = `PRAGMA foreign_keys=ON;\nBEGIN;\n${projected.join(";\n")};\n${projected.join(";\n")};\nCOMMIT;\nPRAGMA integrity_check;\nSELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;\n`
    const applied = await sqliteApply(database, transaction)
    const lines = applied.output.trim().split("\n")
    if (lines[0] !== "ok") throw new Error("migration disposable store integrity failed")
    return {
      audit: {
        applicable: true,
        engine: "sqlite-disposable-postgres-compatibility-projection",
        migrationsApplied: migrations.length,
        statementsApplied: statementCount,
        idempotentReplay: true,
        integrity: "ok",
        tables: lines.slice(1),
      },
      receipt: applied.receipt,
    }
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}
