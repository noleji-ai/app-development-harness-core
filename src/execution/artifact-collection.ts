import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProjectStore } from "../state/project-store"
import { assertSafeStateFile } from "../state/safe-path"
import {
  type ArtifactCheckpoint,
  CheckpointSchema,
  validCheckpoint,
} from "./codex-stage-checkpoint"

export async function collectRunArtifact(
  store: ProjectStore,
  runId: string,
  artifactId: string,
): Promise<ArtifactCheckpoint & { sealed: boolean }> {
  const directory = join(store.stateRoot, "evidence")
  const manifest = await store.loadManifest(runId)
  for (const name of await readdir(directory)) {
    if (!/^codex-[a-f0-9]{64}\.checkpoint\.json$/.test(name)) continue
    const path = join(directory, name)
    await assertSafeStateFile(store.projectRoot, path)
    const parsed = CheckpointSchema.safeParse(JSON.parse(await readFile(path, "utf8")))
    if (!parsed.success || parsed.data.runId !== runId) continue
    const state = manifest.stages[parsed.data.stage]
    if (
      state.kind !== "completed" ||
      state.inputHash !== parsed.data.inputHash ||
      parsed.data.result.kind !== "completed" ||
      state.outputHash.split(":")[0] !== parsed.data.result.outputHash
    )
      continue
    const checkpoint = await validCheckpoint(store, path, {
      runId,
      stage: parsed.data.stage,
      inputHash: state.inputHash,
    })
    const artifact = checkpoint?.artifacts.find((item) => item.id === artifactId)
    if (artifact)
      return { ...artifact, sealed: checkpoint?.finalStageOutputHash === state.outputHash }
  }
  throw new Error("Artifact is not current for the requested run")
}
