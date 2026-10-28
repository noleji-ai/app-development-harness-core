import { rmSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"

export function createTempDirectoryTracker() {
  const trackedDirectories = new Set<string>()

  async function create(prefix: string): Promise<string> {
    const directory = await mkdtemp(prefix)
    trackedDirectories.add(directory)
    return directory
  }

  function cleanup(): void {
    const directories = Array.from(trackedDirectories)
    trackedDirectories.clear()
    for (const directory of directories) {
      rmSync(directory, { force: true, recursive: true })
    }
  }

  return { cleanup, create }
}
