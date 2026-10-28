import { afterEach, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createManifest } from "../../src/domain/manifest"
import { readRunnerAdapterReceipts } from "../../src/execution/runner-adapter-receipt"
import { createTrustedAdapterExecutor } from "../../src/execution/trusted-adapter-executor"
import { ProjectStore } from "../../src/state/project-store"
import { createOfficialAdapterFixture } from "../support/official-adapter-fixture"

const {
  cleanup,
  databaseSecretMarkers,
  fixtureFor,
  official: OFFICIAL,
} = createOfficialAdapterFixture()
afterEach(cleanup)

function reportField(report: Readonly<Record<string, unknown>> | undefined, key: string): unknown {
  return report === undefined ? undefined : Reflect.get(report, key)
}

describe("official runner evidence", () => {
  for (const adapter of OFFICIAL) {
    test(`${adapter.id} emits nine actual structured reports`, async () => {
      const { context, log } = await fixtureFor(adapter)
      const store = new ProjectStore(context.projectRoot)
      await store.initialize("create", "2026-07-15T00:00:00.000Z")
      expect((await adapter.scaffold(context)).status).toBe("passed")
      const manifest = createManifest(
        `run-${adapter.id}`,
        "create",
        "Build verified fixture",
        "2026-07-15T00:00:00.000Z",
      )
      manifest.adapterId = adapter.id
      const execute = createTrustedAdapterExecutor({
        store,
        adapters: [adapter],
        ...(context.toolchainPath === undefined ? {} : { toolchainPath: context.toolchainPath }),
        ...(context.executionEnvironment === undefined
          ? {}
          : { executionEnvironment: context.executionEnvironment }),
      })

      const executed = await execute("deploy-ready", manifest)
      expect(executed.kind, JSON.stringify(executed)).toBe("completed")
      const receipts = await readRunnerAdapterReceipts(store)
      expect(receipts).toHaveLength(9)
      expect(
        receipts.every((receipt) => receipt.outcome === "passed" && receipt.exitCode === 0),
      ).toBe(true)
      const receiptByKind = new Map(receipts.map((receipt) => [receipt.kind, receipt]))
      expect(receiptByKind.get("security")?.argv.join(" ")).toContain("internal-audit-worker")
      expect(receiptByKind.get("security")?.argv).not.toContain("--eval")
      if (adapter.id === "backend-go-postgres") {
        expect(receiptByKind.get("production_build")?.argv).toEqual(["go", "build", "./cmd/server"])
        expect(receiptByKind.get("unit_integration_tests")?.argv).toEqual([
          "go",
          "test",
          "-json",
          "./...",
        ])
        expect(receiptByKind.get("manual_surface_qa")?.argv.join(" ")).toContain(
          "surface-qa-worker",
        )
        expect(receiptByKind.get("release_bundle")?.argv.join(" ")).toContain("-trimpath")
      }
      const reports = new Map<string, Record<string, unknown>>()
      for (const receipt of receipts) {
        const artifact = receipt.artifacts[0]
        expect(artifact).toBeDefined()
        if (artifact !== undefined) {
          reports.set(
            receipt.kind,
            JSON.parse(await readFile(join(store.projectRoot, artifact.path), "utf8")),
          )
        }
      }
      expect(reports.get("security")).toMatchObject({ status: "passed", findings: [] })
      const backup = reports.get("backup_restore")
      if (adapter.platform === "backend") {
        expect(reportField(backup, "details")).toMatchObject({
          mode: "stateful",
          contract: "postgresql",
          matched: true,
        })
        const calls = await readFile(log, "utf8")
        expect(calls).toContain("pg_dump")
        expect(calls).toContain("pg_restore")
        expect(calls).toContain("SELECT COUNT(*) FROM service_metadata")
        const persistedReport = JSON.stringify(backup)
        for (const secret of databaseSecretMarkers) {
          expect(persistedReport).not.toContain(secret)
        }
        expect(persistedReport).toContain("[REDACTED_DATABASE_URL]")
      } else {
        expect(reportField(backup, "details")).toMatchObject({
          mode: "stateless",
          indicators: [],
        })
      }
      const migrations = reports.get("migrations")
      if (adapter.platform === "backend") {
        expect(reportField(migrations, "application")).toMatchObject({
          integrity: "ok",
          idempotentReplay: true,
        })
      } else {
        expect(reportField(migrations, "application")).toMatchObject({
          applicable: false,
          verifiedNotApplicable: true,
        })
      }
      const build = reports.get("production_build")
      expect(reportField(build, "outputArtifacts")).toBeInstanceOf(Array)
      expect(
        await readFile(join(store.stateRoot, "releases", adapter.id, "roundtrip.json"), "utf8"),
      ).toContain('"sha256"')
    })
  }

  test("forged project scripts produce no runner receipts", async () => {
    const adapter = OFFICIAL.find((candidate) => candidate.id === "web-next")
    expect(adapter).toBeDefined()
    if (adapter === undefined) return
    const { context } = await fixtureFor(adapter, { forgedProjectEvidenceOnly: true })
    const store = new ProjectStore(context.projectRoot)
    await store.initialize("create", "2026-07-15T00:00:00.000Z")
    expect((await adapter.scaffold(context)).status).toBe("passed")
    await writeFile(
      join(context.projectRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          build: "mkdir -p .next && printf forged > .next/BUILD_ID",
          test: "printf HARNESS_TESTS_PASSED=99",
          "qa:surface": "printf HARNESS_QA_PASSED=99",
        },
        dependencies: { next: "16.2.10" },
      })}\n`,
    )
    const manifest = createManifest(
      "run-forged-project-scripts",
      "create",
      "Attempt marker forgery",
      "2026-07-15T00:00:00.000Z",
    )
    manifest.adapterId = adapter.id
    const execute = createTrustedAdapterExecutor({
      store,
      adapters: [adapter],
      ...(context.toolchainPath === undefined ? {} : { toolchainPath: context.toolchainPath }),
      ...(context.executionEnvironment === undefined
        ? {}
        : { executionEnvironment: context.executionEnvironment }),
    })

    expect((await execute("deploy-ready", manifest)).kind).toBe("unverified")
    await expect(
      readFile(join(store.stateRoot, "evidence", "runner-adapter-receipts.jsonl"), "utf8"),
    ).rejects.toHaveProperty("code", "ENOENT")
  })
})
