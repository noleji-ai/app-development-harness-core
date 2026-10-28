import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOfficialAdapterFixture } from "../support/official-adapter-fixture"

const {
  cleanup,
  fixtureFor,
  official: OFFICIAL,
  trackedTempDirectory,
} = createOfficialAdapterFixture()
afterEach(cleanup)

describe("official adapter path security", () => {
  test("a scaffold never follows a nested symlink or creates unrequested platforms", async () => {
    const adapter = OFFICIAL.find((candidate) => candidate.id === "web-next")
    expect(adapter).toBeDefined()
    if (adapter === undefined) return
    const { context } = await fixtureFor(adapter)
    const outside = await trackedTempDirectory(join(tmpdir(), "adapter-outside-"))
    await mkdir(join(context.projectRoot, "app"))
    await symlink(outside, join(context.projectRoot, "app", "generated"))

    const result = await adapter.scaffold(context)

    expect(result.status).toBe("blocked")
    await expect(readFile(join(outside, "page.tsx"), "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    )
    await expect(
      readFile(join(context.projectRoot, "Package.swift"), "utf8"),
    ).rejects.toHaveProperty("code", "ENOENT")
    await expect(
      readFile(join(context.projectRoot, "settings.gradle.kts"), "utf8"),
    ).rejects.toHaveProperty("code", "ENOENT")
  })

  test("release manifest never follows a symlink", async () => {
    const adapter = OFFICIAL.find((candidate) => candidate.id === "web-next")
    expect(adapter).toBeDefined()
    if (adapter === undefined) return
    const { context } = await fixtureFor(adapter)
    expect((await adapter.scaffold(context)).status).toBe("passed")
    const outside = join(await trackedTempDirectory(join(tmpdir(), "release-outside-")), "owned")
    await writeFile(outside, "owned\n")
    const release = join(context.projectRoot, ".app-harness", "releases", adapter.id)
    await mkdir(release, { recursive: true })
    await symlink(outside, join(release, "manifest.json"))

    const result = await adapter.packageDeployReady(context)

    expect(result.status).toBe("blocked")
    expect(await readFile(outside, "utf8")).toBe("owned\n")
  })

  test("tool commands never follow a declared output symlink", async () => {
    const adapter = OFFICIAL.find((candidate) => candidate.id === "backend-go-postgres")
    expect(adapter).toBeDefined()
    if (adapter === undefined) return
    const { context } = await fixtureFor(adapter)
    expect((await adapter.scaffold(context)).status).toBe("passed")
    const outside = join(await trackedTempDirectory(join(tmpdir(), "command-outside-")), "owned")
    await writeFile(outside, "owned\n")
    await symlink(outside, join(context.projectRoot, "server"))

    const result = await adapter.build(context)

    expect(result.status).toBe("blocked")
    expect(result.summary).toContain("unsafe_command_path")
    expect(await readFile(outside, "utf8")).toBe("owned\n")
  })

  test("tool commands reject a symbolic-link project root", async () => {
    const adapter = OFFICIAL.find((candidate) => candidate.id === "backend-go-postgres")
    expect(adapter).toBeDefined()
    if (adapter === undefined) return
    const { context } = await fixtureFor(adapter)
    expect((await adapter.scaffold(context)).status).toBe("passed")
    const parent = await trackedTempDirectory(join(tmpdir(), "project-alias-"))
    const alias = join(parent, "project")
    await symlink(context.projectRoot, alias)

    const result = await adapter.build({ ...context, projectRoot: alias })

    expect(result.status).toBe("blocked")
    expect(result.summary).toContain("unsafe_command_path")
  })
})
