import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { executeCli } from "../../src/cli/commands"
import { createManifest } from "../../src/domain/manifest"
import { runCodexAppServer } from "../../src/execution/codex-app-server"
import { runCodexExec } from "../../src/execution/codex-exec"
import { resolveModelPolicy } from "../../src/execution/model-policy"
import { ProjectStore } from "../../src/state/project-store"

test("exec transport pins model and effort and reports native usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-policy-"))
  try {
    const binary = join(root, "codex.cjs")
    const capture = join(root, "argv.json")
    const output = join(root, "output.json")
    await writeFile(
      binary,
      `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
fs.writeFileSync(args[args.indexOf('-o')+1], '{}');
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:20}}));`,
    )
    await chmod(binary, 0o700)
    const result = await runCodexExec({
      projectRoot: root,
      binary,
      prompt: "bounded task",
      schemaPath: join(root, "schema.json"),
      outputPath: output,
      timeoutMs: 5000,
      policy: resolveModelPolicy("implementation"),
    })
    assert.equal(result.kind, "output")
    if (result.kind !== "output") throw new Error("expected output")
    assert.deepEqual(result.usage?.tokens, { input: 100, cachedInput: 40, output: 20 })
    const args: string[] = JSON.parse(await readFile(capture, "utf8"))
    assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-terra")
    assert.ok(args.includes('model_reasoning_effort="medium"'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const response of ["missing", "mismatch", "reroute"] as const) {
  test(`app-server rejects ${response} model identity`, async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-server-policy-"))
    try {
      const binary = join(root, "server.cjs")
      await writeFile(
        binary,
        `#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>console.log(JSON.stringify(x));
rl.on('line',line=>{const m=JSON.parse(line);
if(m.id===1)send({id:1,result:{}});
if(m.id===2)send({id:2,result:{thread:{id:'t'},model:${response === "missing" ? "undefined" : JSON.stringify(response === "mismatch" ? "wrong" : "gpt-5.6-terra")}}});
if(m.id===3)send({method:'model/rerouted',params:{threadId:'t',toModel:'wrong'}});
});`,
      )
      await chmod(binary, 0o700)
      const result = await runCodexAppServer({
        projectRoot: root,
        binary,
        prompt: "bounded",
        timeoutMs: 5000,
        policy: resolveModelPolicy("implementation"),
      })
      assert.equal(result.kind, "failed")
      assert.equal(result.safeToRetry, false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("stale run and unrecorded decision identifiers cannot mutate another active run", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-correlation-"))
  try {
    const store = new ProjectStore(root)
    await store.initialize("create")
    await store.createRun(createManifest("run-current", "create", "test"))
    const before = JSON.stringify(await store.loadActiveManifest())
    for (const args of [
      ["verify", "--run-id", "run-stale"],
      ["resume", "--run-id", "run-current", "--decision-event-id", "unknown"],
    ]) {
      await assert.rejects(() =>
        executeCli(
          [...args, "--project", root],
          { stdout: () => undefined, stderr: () => undefined },
          {},
        ),
      )
      assert.equal(JSON.stringify(await store.loadActiveManifest()), before)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
