import type { Platform } from "../domain/technology"

export type AdapterCommand = {
  readonly executable: string
  readonly args: readonly string[]
  readonly writablePaths?: readonly string[]
}

export type AdapterArtifact = {
  readonly path: string
  readonly contents: string
}

export type AdapterPersistence =
  | { readonly kind: "stateless" }
  | {
      readonly kind: "postgresql"
      readonly databaseUrlEnvironment: "APP_HARNESS_BACKUP_DATABASE_URL"
      readonly disposableEnvironment: "APP_HARNESS_BACKUP_DATABASE_DISPOSABLE"
      readonly observe: AdapterCommand
      readonly backup: AdapterCommand
      readonly mutate: AdapterCommand
      readonly restore: AdapterCommand
    }

export const STATELESS_PERSISTENCE = { kind: "stateless" } as const

const SNAPSHOT = ".app-harness/adapter-evidence/postgresql-backup.snapshot"
const DATABASE_URL = "{databaseUrl}"

export const POSTGRESQL_PERSISTENCE = {
  kind: "postgresql",
  databaseUrlEnvironment: "APP_HARNESS_BACKUP_DATABASE_URL",
  disposableEnvironment: "APP_HARNESS_BACKUP_DATABASE_DISPOSABLE",
  observe: {
    executable: "psql",
    args: [
      DATABASE_URL,
      "--tuples-only",
      "--no-align",
      "--command",
      "SELECT COUNT(*) FROM service_metadata;",
    ],
  },
  backup: {
    executable: "pg_dump",
    args: [DATABASE_URL, "--format=custom", `--file=${SNAPSHOT}`],
    writablePaths: [SNAPSHOT],
  },
  mutate: {
    executable: "psql",
    args: [DATABASE_URL, "--command", "INSERT INTO service_metadata DEFAULT VALUES;"],
  },
  restore: {
    executable: "pg_restore",
    args: ["--clean", "--if-exists", `--dbname=${DATABASE_URL}`, SNAPSHOT],
  },
} as const satisfies AdapterPersistence

export type OfficialAdapterSpec = {
  readonly id: string
  readonly platform: Platform
  readonly version: string
  readonly observedAt: string
  readonly capabilities: readonly string[]
  readonly persistence: AdapterPersistence
  readonly marker: { readonly path: string; readonly contains: string }
  readonly artifacts: readonly AdapterArtifact[]
  readonly probe: AdapterCommand
  readonly probeOutput?: string
  readonly build: AdapterCommand
  readonly test: AdapterCommand
  readonly manualQa: AdapterCommand
  readonly package: AdapterCommand
  readonly testSources: readonly string[]
  readonly requiredXcodeVersion?: string
}
