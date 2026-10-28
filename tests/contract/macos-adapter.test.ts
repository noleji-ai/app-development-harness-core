import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AdapterContext, AppAdapter } from "../../src/adapters/contract"
import { ADAPTERS } from "../../src/adapters/registry"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(cleanup)

function macosAdapter(): AppAdapter {
  const adapter = ADAPTERS.find((candidate) => candidate.id === "macos-swiftui")
  expect(adapter).toBeDefined()
  if (adapter === undefined) throw new Error("macOS adapter fixture is missing")
  return adapter
}

async function createContext(mode: AdapterContext["mode"] = "create"): Promise<AdapterContext> {
  return {
    projectRoot: await trackedTempDirectory(join(tmpdir(), "app-harness-macos-")),
    mode,
    requestedCapabilities: ["build", "test", "manual-qa", "deploy-ready", "macos-app", "swiftui"],
  }
}

describe("macos-swiftui adapter", () => {
  test("plans and scaffolds an idempotent SwiftUI macOS artifact", async () => {
    // Given
    const adapter = macosAdapter()
    const context = await createContext()

    // When
    const plan = await adapter.plan(context)
    const first = await adapter.scaffold(context)
    const second = await adapter.scaffold({ ...context, mode: "resume" })

    // Then
    expect(plan.status).toBe("passed")
    expect(first.status).toBe("passed")
    expect(second.status).toBe("passed")
    expect(await readFile(join(context.projectRoot, "Package.swift"), "utf8")).toContain(
      ".macOS(.v13)",
    )
    expect(
      await readFile(
        join(context.projectRoot, "Sources/AppHarnessMac/AppHarnessMacApp.swift"),
        "utf8",
      ),
    ).toContain("WindowGroup")
  })

  test("blocks a conflicting scaffold without overwriting the existing file", async () => {
    // Given
    const adapter = macosAdapter()
    const context = await createContext()
    await writeFile(join(context.projectRoot, "Package.swift"), "user-owned\n")

    // When
    const result = await adapter.scaffold(context)

    // Then
    expect(result.status).toBe("blocked")
    expect(await readFile(join(context.projectRoot, "Package.swift"), "utf8")).toBe("user-owned\n")
  })

  test("reports missing xcodebuild as unverified rather than successful", async () => {
    // Given
    const adapter = macosAdapter()
    const context = await createContext()
    expect((await adapter.scaffold(context)).status).toBe("passed")
    const previousPath = Reflect.get(process.env, "PATH")
    Reflect.set(process.env, "PATH", "/app-harness-path-without-xcode")

    try {
      // When
      const result = await adapter.build(context)

      // Then
      expect(result.status).toBe("unverified")
      expect(result.summary).toContain("xcodebuild unavailable")
    } finally {
      if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH")
      else Reflect.set(process.env, "PATH", previousPath)
    }
  })

  test("blocks extend on a dirty worktree and preserves the dirty file", async () => {
    // Given
    const adapter = macosAdapter()
    const context = await createContext("extend")
    const git = Bun.spawn(["/usr/bin/git", "init", context.projectRoot], {
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await git.exited).toBe(0)
    const dirtyFile = join(context.projectRoot, "do-not-touch.txt")
    await writeFile(dirtyFile, "user change\n")

    // When
    const result = await adapter.scaffold(context)

    // Then
    expect(result.status).toBe("blocked")
    expect(await readFile(dirtyFile, "utf8")).toBe("user change\n")
  })

  test("blocks a stale compatibility lock before planning artifacts", async () => {
    // Given
    const adapter = macosAdapter()
    const context = await createContext()

    // When
    const result = await adapter.plan({
      ...context,
      compatibilityLock: {
        adapterVersion: "1.0.0",
        xcodeVersion: "16.4",
        observedAt: "2025-01-01",
      },
    })

    // Then
    expect(result.status).toBe("blocked")
    expect(result.summary).toContain("compatibility registry lock")
  })

  test("treats shell metacharacters in the project path only as path data", async () => {
    // Given
    const adapter = macosAdapter()
    const parent = await trackedTempDirectory(join(tmpdir(), "app-harness-hostile-"))
    const projectRoot = join(parent, "mac;touch injected")
    const context = {
      projectRoot,
      mode: "create",
      requestedCapabilities: ["macos-app"],
    } as const

    // When
    const result = await adapter.scaffold(context)

    // Then
    expect(result.status).toBe("passed")
    expect(await readFile(join(projectRoot, "Package.swift"), "utf8")).toContain("AppHarnessMac")
    await expect(readFile(join(parent, "injected"), "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    )
  })

  test("blocks a nested symlink without writing outside the project", async () => {
    // Given
    const adapter = macosAdapter()
    const context = await createContext()
    const outside = await trackedTempDirectory(join(tmpdir(), "app-harness-outside-"))
    await mkdir(join(context.projectRoot, "Sources"))
    await symlink(outside, join(context.projectRoot, "Sources/AppHarnessMac"))

    // When
    const result = await adapter.scaffold(context)

    // Then
    expect(result.status).toBe("blocked")
    await expect(readFile(join(outside, "AppHarnessMacApp.swift"), "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    )
  })
})
