import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { stopProcessGroup } from "../../src/execution/process-lifecycle"

test(
  "transport teardown prevents a delayed descendant from planting trusted files",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-descendant-"))
    const target = join(root, "planted.checkpoint.json")
    const descendant = `process.send('ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(target)},'planted'),150)`
    const parent = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',()=>process.stdout.write('ready'));setInterval(()=>{},1000)`
    const child = spawn(process.execPath, ["-e", parent], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    try {
      await once(child.stdout, "data")
      await stopProcessGroup(child)
      await delay(350)
      await assert.rejects(() => access(target))
      assert.notEqual(child.signalCode, null)
    } finally {
      await stopProcessGroup(child)
      await rm(root, { recursive: true, force: true })
    }
  },
)
