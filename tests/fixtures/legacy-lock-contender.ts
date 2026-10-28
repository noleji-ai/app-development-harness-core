import { constants } from "node:fs"
import { access, appendFile, open, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

const [projectRoot, contenderId] = process.argv.slice(2)
if (projectRoot === undefined || contenderId === undefined) {
  throw new Error("legacy lock contender requires project root and id")
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false,
  )
}

const lock = join(projectRoot, ".app-harness/locks/decisions.lock")
const entered = join(projectRoot, `entered-${contenderId}`)
const release = join(projectRoot, `release-${contenderId}`)
const generation = join(projectRoot, "manifest-generation.txt")
const events = join(projectRoot, "decision-ledger-events.jsonl")

await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600).then(
  async (handle) => {
    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      )
      await handle.sync()
      await writeFile(entered, contenderId, { flag: "wx" })
      const current = Number.parseInt(await readFile(generation, "utf8"), 10)
      await writeFile(generation, `${current + 1}\n`)
      await appendFile(events, `${contenderId}\n`)
      while (!(await exists(release))) await Bun.sleep(5)
      process.stdout.write(JSON.stringify({ id: contenderId, outcome: "released" }))
    } finally {
      await handle.close()
      await unlink(lock)
    }
  },
  (error: unknown) =>
    process.stdout.write(
      JSON.stringify({
        id: contenderId,
        outcome: "rejected",
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
)
