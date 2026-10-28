import assert from "node:assert/strict"
import { link, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { afterEach } from "node:test"

import { resolveRunRequest } from "../../src/cli/request-input"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(cleanup)

test("request-file rejects paths outside the project and symbolic links", async () => {
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-request-root-"))
  const outside = await trackedTempDirectory(join(tmpdir(), "app-harness-request-outside-"))
  await writeFile(join(outside, "request.md"), "outside")
  await symlink(join(outside, "request.md"), join(project, "linked.md"))

  await assert.rejects(
    resolveRunRequest(project, ["--request-file", join(outside, "request.md")]),
    /escapes the project/,
  )
  await assert.rejects(
    resolveRunRequest(project, ["--request-file", "linked.md"]),
    /non-symlink regular file/,
  )
})

test("request-file rejects hard links, unsupported types, and oversized input", async () => {
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-request-limits-"))
  const original = join(project, "original.md")
  await writeFile(original, "request")
  await link(original, join(project, "hard-link.md"))
  await writeFile(join(project, "request.yaml"), "request: test")
  await writeFile(join(project, "large.txt"), Buffer.alloc(256 * 1024 + 1, 65))

  await assert.rejects(
    resolveRunRequest(project, ["--request-file", "hard-link.md"]),
    /non-symlink regular file/,
  )
  await assert.rejects(resolveRunRequest(project, ["--request-file", "request.yaml"]), /file type/)
  await assert.rejects(resolveRunRequest(project, ["--request-file", "large.txt"]), /256 KiB/)
})

test("request-file rejects invalid UTF-8 and strict JSON contract violations", async () => {
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-request-json-"))
  await writeFile(join(project, "invalid.txt"), Buffer.from([0xc3, 0x28]))
  await writeFile(join(project, "malformed.json"), "{")
  await writeFile(join(project, "unknown.json"), '{"request":"build","extra":true}')

  await assert.rejects(resolveRunRequest(project, ["--request-file", "invalid.txt"]), /valid UTF-8/)
  await assert.rejects(
    resolveRunRequest(project, ["--request-file", "malformed.json"]),
    /malformed/,
  )
  await assert.rejects(
    resolveRunRequest(project, ["--request-file", "unknown.json"]),
    /only a non-empty/,
  )
})

test("run request input requires exactly one bounded source", async () => {
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-request-source-"))
  await writeFile(join(project, "request.md"), "build")

  await assert.rejects(resolveRunRequest(project, []), /exactly one/)
  await assert.rejects(
    resolveRunRequest(project, ["--request", "build", "--request-file", "request.md"]),
    /exactly one/,
  )
  await assert.rejects(
    resolveRunRequest(project, ["--request-file", "request.md", "--request-file", "request.md"]),
    /exactly one/,
  )
  await assert.rejects(resolveRunRequest(project, ["--request", "\0"]), /256 KiB/)
})
