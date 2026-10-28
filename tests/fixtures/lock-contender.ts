import { constants } from "node:fs"
import { access, appendFile, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { withFileLock } from "../../src/state/file-lock"

const [projectRoot, contenderId] = process.argv.slice(2)
if (projectRoot === undefined || contenderId === undefined) {
  throw new Error("lock contender requires project root and id")
}

async function released(path: string): Promise<boolean> {
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

await withFileLock(projectRoot, lock, async () => {
  await writeFile(entered, contenderId, { flag: "wx" })
  if (await released(generation)) {
    const current = Number.parseInt(await readFile(generation, "utf8"), 10)
    await writeFile(generation, `${current + 1}\n`)
    await appendFile(events, `${contenderId}\n`)
  }
  while (!(await released(release))) await Bun.sleep(5)
}).then(
  () => process.stdout.write(JSON.stringify({ id: contenderId, outcome: "released" })),
  (error: unknown) =>
    process.stdout.write(
      JSON.stringify({
        id: contenderId,
        outcome: "rejected",
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
)
