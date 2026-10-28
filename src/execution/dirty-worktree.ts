import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { chmod, lstat, open, realpath, unlink } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

type Snapshot =
  | { readonly path: string; readonly relativePath: string; readonly kind: "missing" }
  | {
      readonly path: string
      readonly relativePath: string
      readonly kind: "file"
      readonly contents: Buffer
      readonly mode: number
    }

export interface DirtyWorktreeSnapshot {
  readonly paths: readonly string[]
  restoreChanges(): Promise<readonly string[]>
}

function environment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = process.env[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function contained(root: string, target: string): boolean {
  const route = relative(root, target)
  return route === "" || (route !== ".." && !route.startsWith(`..${sep}`))
}

async function assertSafeAncestors(root: string, target: string): Promise<boolean> {
  const route = relative(root, dirname(target))
  if (route === "" || route === ".") return true
  let cursor = root
  for (const component of route.split(sep)) {
    cursor = join(cursor, component)
    let state: Awaited<ReturnType<typeof lstat>>
    try {
      state = await lstat(cursor)
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error(`dirty worktree path has an unsafe ancestor: ${relative(root, target)}`)
    }
    if (!contained(root, await realpath(cursor))) {
      throw new Error(`dirty worktree path escaped project: ${relative(root, target)}`)
    }
  }
  return true
}

function statusPaths(stdout: string): string[] {
  const records = stdout.split("\0")
  const paths = new Set<string>()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const status = record.slice(0, 2)
    paths.add(record.slice(3))
    if (/[RC]/.test(status)) {
      const original = records[index + 1]
      if (original) paths.add(original)
      index += 1
    }
  }
  return [...paths].filter((path) => path !== ".app-harness" && !path.startsWith(".app-harness/"))
}

async function snapshotPath(root: string, relativePath: string): Promise<Snapshot> {
  if (relativePath.includes("\0")) throw new Error("dirty worktree path contains a NUL byte")
  const path = resolve(root, relativePath)
  if (!contained(root, path) || path === root)
    throw new Error("dirty worktree path escaped project")
  let state: Awaited<ReturnType<typeof lstat>>
  try {
    state = await lstat(path)
  } catch (error) {
    if (isMissing(error)) return { path, relativePath, kind: "missing" }
    throw error
  }
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    throw new Error(`cannot safely preserve dirty worktree path: ${relativePath}`)
  }
  if (state.size > MAX_FILE_BYTES) {
    throw new Error(`dirty worktree file exceeds preservation limit: ${relativePath}`)
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const after = await handle.stat()
    if (after.dev !== state.dev || after.ino !== state.ino) {
      throw new Error(`dirty worktree file changed while opening: ${relativePath}`)
    }
    return {
      path,
      relativePath,
      kind: "file",
      contents: await handle.readFile(),
      mode: state.mode & 0o777,
    }
  } finally {
    await handle.close()
  }
}

async function sameFile(snapshot: Extract<Snapshot, { kind: "file" }>): Promise<boolean> {
  try {
    const state = await lstat(snapshot.path)
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) return false
    const handle = await open(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return (await handle.readFile()).equals(snapshot.contents)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function restore(snapshot: Snapshot, root: string): Promise<boolean> {
  if (snapshot.kind === "missing") {
    if (!(await assertSafeAncestors(root, snapshot.path))) return false
    try {
      const state = await lstat(snapshot.path)
      if (state.isDirectory())
        throw new Error(`cannot remove replaced dirty path: ${snapshot.relativePath}`)
      const canonical = await realpath(snapshot.path)
      if (!contained(root, canonical) || canonical !== snapshot.path) {
        throw new Error(`dirty worktree path escaped project: ${snapshot.relativePath}`)
      }
      await unlink(snapshot.path)
      return true
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }
  if (await sameFile(snapshot)) return false
  const canonicalParent = await realpath(dirname(snapshot.path))
  if (!contained(await realpath(root), canonicalParent)) {
    throw new Error(`dirty worktree parent escaped project: ${snapshot.relativePath}`)
  }
  let flags = constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW
  try {
    const state = await lstat(snapshot.path)
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
      throw new Error(`cannot restore replaced dirty path: ${snapshot.relativePath}`)
    }
  } catch (error) {
    if (!isMissing(error)) throw error
    flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
  }
  const handle = await open(snapshot.path, flags, snapshot.mode)
  try {
    await handle.writeFile(snapshot.contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(snapshot.path, snapshot.mode)
  return true
}

export async function captureDirtyWorktree(projectRoot: string): Promise<DirtyWorktreeSnapshot> {
  const root = await realpath(resolve(projectRoot))
  try {
    await lstat(join(root, ".git"))
  } catch (error) {
    if (isMissing(error)) return { paths: [], restoreChanges: async () => [] }
    throw error
  }
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8", env: environment(), maxBuffer: 1024 * 1024, timeout: 10_000 },
  )
  const snapshots = await Promise.all(statusPaths(stdout).map((path) => snapshotPath(root, path)))
  if (
    snapshots.reduce(
      (sum, item) => sum + (item.kind === "file" ? item.contents.byteLength : 0),
      0,
    ) > MAX_TOTAL_BYTES
  ) {
    throw new Error("dirty worktree exceeds preservation limit")
  }
  return {
    paths: snapshots.map((item) => item.relativePath),
    restoreChanges: async () => {
      const changed: string[] = []
      for (const item of snapshots) if (await restore(item, root)) changed.push(item.relativePath)
      return changed
    },
  }
}
