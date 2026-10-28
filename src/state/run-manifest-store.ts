import { readFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"

import type { DecisionRecord } from "../domain/decision"
import {
  PIPELINE_STAGES,
  type PipelineStage,
  type RunManifest,
  RunManifestSchema,
} from "../domain/manifest"
import { atomicWriteStateFile, createStateFile } from "./atomic-state-file"
import { createBoundStateDirectory } from "./bound-state-directory"
import { ProjectStateError } from "./errors"
import { withFileLock } from "./file-lock"
import { assertSafeStateDirectory, assertSafeStateFile } from "./safe-path"

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function resetFrom(manifest: RunManifest, stage: PipelineStage): void {
  const index = PIPELINE_STAGES.indexOf(stage)
  for (const downstream of PIPELINE_STAGES.slice(index)) {
    manifest.stages[downstream] = { kind: "pending" }
  }
  manifest.currentStage = stage
  manifest.releaseReady = false
}

export class RunManifestStore {
  constructor(
    private readonly projectRoot: string,
    private readonly stateRoot: string,
  ) {}

  private path(runId: string): string {
    if (!RUN_ID_PATTERN.test(runId)) throw new ProjectStateError("Invalid run id")
    const path = join(this.stateRoot, "runs", runId, "manifest.json")
    const route = relative(this.projectRoot, path)
    if (route === ".." || route.startsWith(`..${sep}`)) {
      throw new ProjectStateError("State path escapes the project root")
    }
    return path
  }

  async create(manifest: RunManifest): Promise<void> {
    const path = this.path(manifest.runId)
    await assertSafeStateDirectory(this.projectRoot, join(this.stateRoot, "runs"))
    await createBoundStateDirectory(this.projectRoot, dirname(path))
    await assertSafeStateDirectory(this.projectRoot, dirname(path))
    await assertSafeStateFile(this.projectRoot, path)
    await createStateFile(this.projectRoot, path, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  async load(runId: string): Promise<RunManifest> {
    const path = this.path(runId)
    await assertSafeStateFile(this.projectRoot, path)
    return RunManifestSchema.parse(JSON.parse(await readFile(path, "utf8")))
  }

  async save(manifest: RunManifest, expectedGeneration = manifest.generation): Promise<void> {
    const manifestPath = this.path(manifest.runId)
    const lock = join(this.stateRoot, "locks", `manifest-${manifest.runId}.lock`)
    await assertSafeStateFile(this.projectRoot, lock)
    await withFileLock(this.projectRoot, lock, async () => {
      const current = await this.load(manifest.runId)
      if (current.generation !== expectedGeneration) {
        throw new ProjectStateError(
          `Manifest conflict: expected generation ${expectedGeneration}, got ${current.generation}`,
        )
      }
      manifest.generation = expectedGeneration + 1
      await atomicWriteStateFile(
        this.projectRoot,
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
    })
  }

  async invalidate(runId: string, stage: PipelineStage, now: string): Promise<RunManifest> {
    const manifest = await this.load(runId)
    resetFrom(manifest, stage)
    manifest.updatedAt = now
    await this.save(manifest)
    return manifest
  }

  async reconcile(
    runId: string,
    events: readonly DecisionRecord[],
    now: string,
  ): Promise<RunManifest> {
    const manifest = await this.load(runId)
    let changed = false
    for (const event of events) {
      if (event.runId !== runId) continue
      const appliedRevision = manifest.decisionRevisions[event.id] ?? 0
      if (event.revision <= appliedRevision) continue
      const missingPredecessor = event.revision > appliedRevision + 1
      if (event.revision > 1 && (event.action !== "comment" || missingPredecessor)) {
        resetFrom(manifest, event.stage)
      }
      manifest.decisionRevisions[event.id] = event.revision
      changed = true
    }
    if (!changed) return manifest
    manifest.updatedAt = now
    await this.save(manifest)
    return manifest
  }
}
