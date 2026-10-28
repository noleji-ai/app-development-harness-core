import { lstat } from "node:fs/promises"
import { dirname, join } from "node:path"

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return Reflect.get(error, "code") === "ENOENT"
}

export async function findUnsafeArtifactDirectory(
  projectRoot: string,
  artifactPaths: readonly string[],
): Promise<string | undefined> {
  for (const artifactPath of artifactPaths) {
    const segments = dirname(artifactPath)
      .split("/")
      .filter((segment) => segment !== ".")
    let current = projectRoot
    for (const segment of segments) {
      current = join(current, segment)
      try {
        const state = await lstat(current)
        if (!state.isDirectory() || state.isSymbolicLink()) return current
      } catch (error) {
        if (isMissing(error)) break
        throw error
      }
    }
  }
  return undefined
}
