import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"

import type { AdapterContext, AdapterResult } from "./contract"
import { findUnsafeArtifactDirectory } from "./macos-paths"
import type { AdapterArtifact } from "./official-types"

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const value = Reflect.get(error, "code")
  return typeof value === "string" ? value : undefined
}

async function fileContents(path: string): Promise<string | undefined> {
  try {
    const state = await lstat(path)
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
      throw new UnsafeArtifactError(path)
    }
    return await readFile(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

export class UnsafeArtifactError extends Error {
  readonly name = "UnsafeArtifactError"
  constructor(readonly path: string) {
    super(`unsafe artifact path: ${path}`)
  }
}

function contained(root: string, target: string): boolean {
  const route = relative(root, target)
  return route !== "" && route !== ".." && !route.startsWith(`..${sep}`)
}

export async function findUnsafeWritablePath(
  projectRoot: string,
  paths: readonly string[],
): Promise<string | undefined> {
  const root = resolve(projectRoot)
  const rootState = await lstat(root)
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) return root
  const unsafeDirectory = await findUnsafeArtifactDirectory(root, paths)
  if (unsafeDirectory !== undefined) return unsafeDirectory
  for (const path of paths) {
    const target = resolve(root, path)
    if (!contained(root, target)) return target
    try {
      const state = await lstat(target)
      if (state.isSymbolicLink() || (state.isFile() && state.nlink !== 1)) return target
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
  }
  return undefined
}

export async function writeArtifacts(
  context: AdapterContext,
  artifacts: readonly AdapterArtifact[],
): Promise<AdapterResult | undefined> {
  await mkdir(context.projectRoot, { recursive: true })
  const root = resolve(context.projectRoot)
  const state = await lstat(root)
  if (!state.isDirectory() || state.isSymbolicLink()) {
    return { status: "blocked", summary: "unsafe project root", commands: [] }
  }
  const unsafe = await findUnsafeArtifactDirectory(
    root,
    artifacts.map((item) => item.path),
  )
  if (unsafe !== undefined) {
    return { status: "blocked", summary: `unsafe scaffold path: ${unsafe}`, commands: [] }
  }
  try {
    for (const artifact of artifacts) {
      const target = resolve(root, artifact.path)
      if (!contained(root, target)) throw new UnsafeArtifactError(target)
      const current = await fileContents(target)
      if (current !== undefined && current !== artifact.contents) {
        return {
          status: "blocked",
          summary: `existing file conflict: ${artifact.path}`,
          commands: [],
        }
      }
    }
    for (const artifact of artifacts) {
      const target = resolve(root, artifact.path)
      if ((await fileContents(target)) !== undefined) continue
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, artifact.contents, { flag: "wx", mode: 0o600 })
    }
  } catch (error) {
    if (error instanceof UnsafeArtifactError) {
      return { status: "blocked", summary: error.message, commands: [] }
    }
    throw error
  }
  return undefined
}

export async function matchesMarker(
  projectRoot: string,
  marker: { readonly path: string; readonly contains: string },
): Promise<boolean> {
  try {
    return (
      (await fileContents(resolve(projectRoot, marker.path)))?.includes(marker.contains) ?? false
    )
  } catch (error) {
    if (error instanceof UnsafeArtifactError) return false
    throw error
  }
}
