import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import type { AdapterOutputArtifact } from "./contract"

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

function contained(root: string, target: string): boolean {
  const route = relative(root, target)
  return route === "" || (route !== ".." && !route.startsWith(`..${sep}`))
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function files(path: string): Promise<string[]> {
  const state = await lstat(path)
  if (state.isSymbolicLink()) throw new Error("adapter output contains a symbolic link")
  if (state.isFile()) return [path]
  if (!state.isDirectory()) throw new Error("adapter output has an unsupported type")
  const result: string[] = []
  for (const entry of (await readdir(path)).sort()) result.push(...(await files(join(path, entry))))
  return result
}

export async function collectOutputArtifacts(
  projectRoot: string,
  declaredPaths: readonly string[],
): Promise<AdapterOutputArtifact[]> {
  const root = await realpath(resolve(projectRoot))
  const result: AdapterOutputArtifact[] = []
  for (const declared of declaredPaths) {
    if (declared.includes("\0") || isAbsolute(declared))
      throw new Error("unsafe adapter output path")
    const target = resolve(root, declared)
    if (!contained(root, target) || target === root)
      throw new Error("adapter output escaped project")
    let candidates: string[]
    try {
      candidates = await files(target)
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    for (const candidate of candidates) {
      const state = await lstat(candidate)
      if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size === 0)
        continue
      if (state.size > MAX_ARTIFACT_BYTES) throw new Error("adapter output exceeds size limit")
      if (!contained(root, await realpath(candidate)))
        throw new Error("adapter output escaped project")
      const contents = await readFile(candidate)
      result.push({
        path: relative(root, candidate),
        sha256: createHash("sha256").update(contents).digest("hex"),
        size: contents.byteLength,
      })
      if (result.length === 10) return result
    }
  }
  return result
}

export async function verifyOutputArtifacts(
  projectRoot: string,
  artifacts: readonly AdapterOutputArtifact[],
): Promise<void> {
  const root = await realpath(resolve(projectRoot))
  if (artifacts.length === 0 || artifacts.length > 10) throw new Error("invalid adapter outputs")
  for (const artifact of artifacts) {
    if (isAbsolute(artifact.path) || artifact.path.includes("\0")) {
      throw new Error("unsafe adapter output path")
    }
    const path = resolve(root, artifact.path)
    const state = await lstat(path)
    if (
      !contained(root, path) ||
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.nlink !== 1 ||
      state.size !== artifact.size ||
      state.size === 0
    ) {
      throw new Error("adapter output is not a trusted regular file")
    }
    if (!contained(root, await realpath(path))) throw new Error("adapter output escaped project")
    const hash = createHash("sha256")
      .update(await readFile(path))
      .digest("hex")
    if (hash !== artifact.sha256) throw new Error("adapter output artifact hash mismatch")
  }
}
