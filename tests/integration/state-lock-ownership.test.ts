import { afterEach, describe, expect, test } from "bun:test"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
const children: ChildProcessWithoutNullStreams[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  cleanup()
})

type Contender = {
  readonly child: ChildProcessWithoutNullStreams
  readonly result: Promise<{
    readonly id: string
    readonly outcome: string
    readonly message?: string
  }>
}

function contender(projectRoot: string, id: string): Contender {
  return fixtureContender("lock-contender.ts", projectRoot, id)
}

function legacyContender(projectRoot: string, id: string): Contender {
  return fixtureContender("legacy-lock-contender.ts", projectRoot, id)
}

function fixtureContender(fixture: string, projectRoot: string, id: string): Contender {
  const child = spawn(process.execPath, [resolve("tests/fixtures", fixture), projectRoot, id], {
    cwd: resolve("."),
    env: {},
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  })
  children.push(child)
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  const result = new Promise<{
    readonly id: string
    readonly outcome: string
    readonly message?: string
  }>((resolveResult, rejectResult) => {
    child.once("error", rejectResult)
    child.once("close", (code) => {
      if (code !== 0) {
        rejectResult(new Error(`contender ${id} exited ${code}: ${stderr}`))
        return
      }
      resolveResult(JSON.parse(stdout))
    })
  })
  return { child, result }
}

async function entered(projectRoot: string): Promise<string[]> {
  return (await readdir(projectRoot)).filter((name) => name.startsWith("entered-"))
}

async function claims(projectRoot: string): Promise<string[]> {
  return (await readdir(join(projectRoot, ".app-harness/locks"))).filter(
    (name) => name.startsWith(".decisions.lock.") && name.endsWith(".claim"),
  )
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for lock contender")
    await Bun.sleep(10)
  }
}

async function writeCurrentFence(path: string, token: string): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({
      kind: "app-harness-lock-fence",
      protocolVersion: 2,
      pid: 1,
      createdAt: "2026-07-14T00:00:00.000Z",
      token,
    })}\n`,
    { mode: 0o600 },
  )
}

describe("cross-process state lock ownership", () => {
  test("a UUID holder excludes a previous fixed-path client", async () => {
    // Given
    const project = await trackedTempDirectory(join(tmpdir(), "app-harness-mixed-lock-"))
    await mkdir(join(project, ".app-harness/locks"), { recursive: true, mode: 0o700 })
    await writeFile(join(project, "manifest-generation.txt"), "0\n")
    await writeFile(join(project, "decision-ledger-events.jsonl"), "")
    const current = contender(project, "current")

    try {
      // When
      await waitUntil(async () => (await entered(project)).includes("entered-current"))
      const legacy = legacyContender(project, "legacy")
      const observation = await Promise.race([
        legacy.result.then((result) => ({ kind: "result" as const, result })),
        waitUntil(async () => (await entered(project)).includes("entered-legacy")).then(
          () => ({ kind: "entered" as const }),
          () => ({ kind: "timeout" as const }),
        ),
      ])

      // Then
      expect(observation.kind).toBe("result")
      expect(observation.kind === "result" ? observation.result.outcome : undefined).toBe(
        "rejected",
      )
      expect(await entered(project)).toEqual(["entered-current"])
      await writeFile(join(project, "release-current"), "release")
      expect((await current.result).outcome).toBe("released")
      expect(await readFile(join(project, "manifest-generation.txt"), "utf8")).toBe("1\n")
      expect(await readFile(join(project, "decision-ledger-events.jsonl"), "utf8")).toBe(
        "current\n",
      )
    } finally {
      await writeFile(join(project, "release-current"), "release")
      await writeFile(join(project, "release-legacy"), "release")
    }
  }, 15_000)

  test("an active previous client excludes current clients before a safe protocol transition", async () => {
    // Given
    const project = await trackedTempDirectory(join(tmpdir(), "app-harness-mixed-transition-"))
    const base = join(project, ".app-harness/locks/decisions.lock")
    await mkdir(join(project, ".app-harness/locks"), { recursive: true, mode: 0o700 })
    await writeFile(join(project, "manifest-generation.txt"), "0\n")
    await writeFile(join(project, "decision-ledger-events.jsonl"), "")
    const legacy = legacyContender(project, "legacy-first")

    try {
      // When: the previous client owns the base pathname.
      await waitUntil(async () => (await entered(project)).includes("entered-legacy-first"))
      const blockedCurrent = contender(project, "current-blocked")

      // Then: the current client fails closed until the previous owner releases.
      expect((await blockedCurrent.result).outcome).toBe("rejected")
      expect(await entered(project)).toEqual(["entered-legacy-first"])
      await writeFile(join(project, "release-legacy-first"), "release")
      expect((await legacy.result).outcome).toBe("released")

      // When: a current successor acquires after the safe release transition.
      const current = contender(project, "current-after-release")
      await waitUntil(async () =>
        (await entered(project)).includes("entered-current-after-release"),
      )
      await writeFile(join(project, "release-current-after-release"), "release")
      expect((await current.result).outcome).toBe("released")

      // Then: state updates are preserved and the permanent fence excludes old clients.
      expect(await readFile(join(project, "manifest-generation.txt"), "utf8")).toBe("2\n")
      expect(await readFile(join(project, "decision-ledger-events.jsonl"), "utf8")).toBe(
        "legacy-first\ncurrent-after-release\n",
      )
      const fence = JSON.parse(await readFile(base, "utf8"))
      expect(fence.protocolVersion).toBe(2)
      expect(fence.pid).toBe(1)
      expect((await legacyContender(project, "legacy-after-upgrade").result).outcome).toBe(
        "rejected",
      )
    } finally {
      for (const id of [
        "legacy-first",
        "current-blocked",
        "current-after-release",
        "legacy-after-upgrade",
      ]) {
        await writeFile(join(project, `release-${id}`), "release")
      }
    }
  }, 15_000)

  test("current contenders never remove the active holder or its successor", async () => {
    // Given
    const project = await trackedTempDirectory(join(tmpdir(), "app-harness-lock-owner-"))
    const locks = join(project, ".app-harness/locks")
    const legacy = join(locks, "decisions.lock")
    await mkdir(locks, { recursive: true, mode: 0o700 })
    await writeCurrentFence(legacy, "20000000-0000-4000-8000-000000000001")
    const first = contender(project, "first")
    const second = contender(project, "second")

    try {
      // When
      await waitUntil(async () => (await entered(project)).length >= 1)
      await Bun.sleep(250)
      const activeClaims = await claims(project)

      // Then
      expect(await entered(project)).toHaveLength(1)
      expect(activeClaims).toHaveLength(1)
      const claim = join(locks, activeClaims[0] ?? "missing")
      const metadata = JSON.parse(await readFile(claim, "utf8"))
      expect(metadata.status).toBe("held")
      expect(metadata.token).toBeString()
      expect((await stat(claim)).nlink).toBe(1)
      expect(JSON.parse(await readFile(legacy, "utf8")).protocolVersion).toBe(2)

      const winner = (await entered(project))[0]?.slice("entered-".length)
      expect(winner).toBeDefined()
      await writeFile(join(project, `release-${winner}`), "release")
      const outcomes = await Promise.all([first.result, second.result])
      expect(outcomes.filter((item) => item.outcome === "released")).toHaveLength(1)
      expect(outcomes.filter((item) => item.outcome === "rejected")).toHaveLength(1)
      expect(await claims(project)).toEqual([])

      const successor = contender(project, "successor")
      await waitUntil(async () => (await entered(project)).includes("entered-successor"))
      expect(await claims(project)).toHaveLength(1)
      await writeFile(join(project, "release-successor"), "release")
      expect((await successor.result).outcome).toBe("released")
      expect(await claims(project)).toEqual([])
    } finally {
      await Promise.all(
        ["first", "second", "successor"].map((id) =>
          writeFile(join(project, `release-${id}`), "release"),
        ),
      )
    }
  }, 15_000)
})
