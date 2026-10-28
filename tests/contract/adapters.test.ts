import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ADAPTERS } from "../../src/adapters/registry"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(cleanup)

async function context() {
  return {
    projectRoot: await trackedTempDirectory(join(tmpdir(), "app-harness-contract-")),
    mode: "create",
    requestedCapabilities: ["build"],
  } as const
}

describe("adapter contract", () => {
  for (const adapter of ADAPTERS) {
    test(`${adapter.id} implements every operation without deployment`, async () => {
      const [detect, plan, scaffold, build, unitTest, manualQa, packageReady] = await Promise.all([
        context(),
        context(),
        context(),
        context(),
        context(),
        context(),
        context(),
      ])
      const results = await Promise.all([
        adapter.detect(detect),
        adapter.plan(plan),
        adapter.scaffold(scaffold),
        adapter.build(build),
        adapter.test(unitTest),
        adapter.manualQa(manualQa),
        adapter.packageDeployReady(packageReady),
      ])
      expect(results).toHaveLength(7)
      expect(
        results.every((result) => result.status !== "passed" || result.summary.length > 0),
      ).toBe(true)
      expect(adapter).not.toHaveProperty("deploy")
    })

    test(`${adapter.id} blocks unsupported capabilities`, async () => {
      const project = await context()
      const result = await adapter.plan({
        ...project,
        requestedCapabilities: ["impossible-capability"],
      })
      expect(result.status).toBe("blocked")
      expect(result.summary).toContain("capability_extension_required")
    })
  }
})
