import { lstat, readdir, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"

import { atomicWriteStateFile } from "../state/atomic-state-file"
import type { ProjectStore } from "../state/project-store"
import { assertSafeStateFile } from "../state/safe-path"

const TRUSTED_FILES = [
  "evidence/index.jsonl",
  "evidence/adapter-receipts.jsonl",
  "evidence/runner-adapter-receipts.jsonl",
  "evidence/model-usage.jsonl",
] as const

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

export async function captureTrustedEvidence(store: ProjectStore): Promise<() => Promise<boolean>> {
  const checkpoints = (await readdir(join(store.stateRoot, "evidence")))
    .filter((name) =>
      /^(codex-[a-f0-9]{64}\.checkpoint|model-execution-[a-f0-9]{64})\.json$/.test(name),
    )
    .map((name) => `evidence/${name}`)
  const snapshots = await Promise.all(
    [...TRUSTED_FILES, ...checkpoints].map(async (relativePath) => {
      const path = join(store.stateRoot, relativePath)
      try {
        await assertSafeStateFile(store.projectRoot, path)
        return { path, contents: await readFile(path) }
      } catch (error) {
        if (isMissing(error)) return { path, contents: undefined }
        throw error
      }
    }),
  )
  return async () => {
    let changed = false
    const known = new Set(snapshots.map((snapshot) => snapshot.path))
    for (const name of await readdir(join(store.stateRoot, "evidence"))) {
      if (!/^(codex-[a-f0-9]{64}\.checkpoint|model-execution-[a-f0-9]{64})\.json$/.test(name))
        continue
      const path = join(store.stateRoot, "evidence", name)
      if (!known.has(path)) snapshots.push({ path, contents: undefined })
    }
    for (const snapshot of snapshots) {
      const current = await readFile(snapshot.path).catch((error: unknown) => {
        if (isMissing(error)) return undefined
        throw error
      })
      if (
        (current === undefined && snapshot.contents === undefined) ||
        (current !== undefined &&
          snapshot.contents !== undefined &&
          current.equals(snapshot.contents))
      ) {
        continue
      }
      changed = true
      if (snapshot.contents !== undefined) {
        await atomicWriteStateFile(store.projectRoot, snapshot.path, snapshot.contents)
      } else {
        await assertSafeStateFile(store.projectRoot, snapshot.path)
        const state = await lstat(snapshot.path)
        if (!state.isFile() || state.isSymbolicLink()) {
          throw new Error("trusted evidence path was replaced unsafely")
        }
        await unlink(snapshot.path)
      }
    }
    return changed
  }
}
