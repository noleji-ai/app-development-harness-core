import { lstat, realpath } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function assertContained(root: string, target: string, allowEqual = false): void {
  const path = relative(root, target)
  if (path === ".." || path.startsWith(`..${sep}`) || (!allowEqual && path === "")) {
    throw new UnsafeStatePathError(target)
  }
}

export class UnsafeStatePathError extends Error {
  readonly name = "UnsafeStatePathError"
  constructor(readonly target: string) {
    super(`unsafe state path or symlink: ${target}`)
  }
}

function stateTarget(root: string, target: string): { stateRoot: string; target: string } {
  const resolvedRoot = resolve(root)
  const stateRoot = join(resolvedRoot, ".app-harness")
  const resolvedTarget = resolve(target)
  assertContained(resolvedRoot, stateRoot)
  assertContained(stateRoot, resolvedTarget, true)
  return { stateRoot, target: resolvedTarget }
}

export async function assertSafeStateDirectory(root: string, directory: string): Promise<void> {
  const { stateRoot, target } = stateTarget(root, directory)
  const canonicalRoot = await realpath(resolve(root))
  const state = await lstat(stateRoot)
  if (!state.isDirectory() || state.isSymbolicLink()) throw new UnsafeStatePathError(stateRoot)
  const canonicalState = await realpath(stateRoot)
  assertContained(canonicalRoot, canonicalState)
  const route = relative(stateRoot, target)
  let ancestor = stateRoot
  for (const segment of route === "" ? [] : route.split(sep)) {
    ancestor = join(ancestor, segment)
    const current = await lstat(ancestor)
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new UnsafeStatePathError(ancestor)
    }
    assertContained(canonicalState, await realpath(ancestor), true)
  }
}

export async function assertSafeStateFile(root: string, file: string): Promise<void> {
  const { stateRoot, target } = stateTarget(root, file)
  if (target === stateRoot) throw new UnsafeStatePathError(target)
  await assertSafeStateDirectory(root, dirname(target))
  try {
    const state = await lstat(target)
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
      throw new UnsafeStatePathError(target)
    }
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}
