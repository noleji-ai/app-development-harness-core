import { lstat, mkdir, readFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { z } from "zod"

import type { DecisionRecord } from "../domain/decision"
import {
  DEFAULT_DESIGN_POLICY,
  type DesignPolicy,
  DesignPolicySchema,
} from "../domain/design-policy"
import {
  type PipelineStage,
  type RunManifest,
  type RunMode,
  RunModeSchema,
  type WorkflowProfile,
  WorkflowProfileSchema,
} from "../domain/manifest.js"
import { atomicWriteStateFile } from "./atomic-state-file"
import { createBoundStateDirectory } from "./bound-state-directory"
import { ProjectStateError } from "./errors"
import {
  HARNESS_LOCK_SCHEMA_VERSION,
  inspectLockProtocol,
  LOCK_PROTOCOL_VERSION,
  type LockProtocolHealth,
  readHarnessLock,
  upgradeHarnessLock,
} from "./lock-compatibility"
import { RunManifestStore } from "./run-manifest-store"
import { assertSafeStateDirectory, assertSafeStateFile } from "./safe-path"
import { assertCleanGitWorkspace } from "./workspace-guard"

export const STATE_SCHEMA_VERSION = 1
export const HARNESS_VERSION = "1.2.0"

export type UpgradeResult =
  | {
      readonly status: "upgraded"
      readonly config: ProjectConfig
      readonly lockProtocol: LockProtocolHealth
    }
  | { readonly status: "blocked"; readonly lockProtocol: LockProtocolHealth }

export const ProjectConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    harnessVersion: z.string().min(1),
    mode: RunModeSchema,
    workflowProfileDefault: WorkflowProfileSchema.default("full"),
    designPolicy: DesignPolicySchema.default(DEFAULT_DESIGN_POLICY),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()

export const ActiveRunSchema = z
  .object({
    runId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      .nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict()

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>
export type ActiveRun = z.infer<typeof ActiveRunSchema>

export { ProjectStateError } from "./errors"

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false
    }
    throw error
  }
}

function assertInside(root: string, target: string): void {
  const path = relative(root, target)
  if (path === ".." || path.startsWith(`..${sep}`) || resolve(target) === resolve(root)) {
    throw new ProjectStateError("State path escapes the project root")
  }
}

export class ProjectStore {
  readonly projectRoot: string
  readonly stateRoot: string
  private readonly manifests: RunManifestStore

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot)
    this.stateRoot = join(this.projectRoot, ".app-harness")
    assertInside(this.projectRoot, this.stateRoot)
    this.manifests = new RunManifestStore(this.projectRoot, this.stateRoot)
  }

  async initialize(
    mode: RunMode,
    now = new Date().toISOString(),
    designPolicy: DesignPolicy = DEFAULT_DESIGN_POLICY,
    workflowProfileDefault: WorkflowProfile = "lean",
  ): Promise<ProjectConfig> {
    await mkdir(this.projectRoot, { recursive: true })
    if (await exists(this.stateRoot)) {
      await assertSafeStateDirectory(this.projectRoot, this.stateRoot)
      const config = await this.readConfig()
      if (config.mode !== mode && mode !== "resume") {
        throw new ProjectStateError(`Project already initialized in ${config.mode} mode`)
      }
      return config
    }
    if (mode === "extend") await assertCleanGitWorkspace(this.projectRoot)

    await mkdir(this.stateRoot, { mode: 0o700 })
    await assertSafeStateDirectory(this.projectRoot, this.stateRoot)
    const directories = ["runs", "evidence", "adrs", "dashboard", "locks"].map((name) =>
      join(this.stateRoot, name),
    )
    await Promise.all(
      directories.map((directory) => createBoundStateDirectory(this.projectRoot, directory)),
    )
    await Promise.all(
      directories.map((directory) => assertSafeStateDirectory(this.projectRoot, directory)),
    )
    const config: ProjectConfig = {
      schemaVersion: STATE_SCHEMA_VERSION,
      harnessVersion: HARNESS_VERSION,
      mode,
      workflowProfileDefault,
      designPolicy,
      createdAt: now,
      updatedAt: now,
    }
    await Promise.all([
      atomicWriteStateFile(
        this.projectRoot,
        join(this.stateRoot, "config.json"),
        `${JSON.stringify(config, null, 2)}\n`,
      ),
      atomicWriteStateFile(
        this.projectRoot,
        join(this.stateRoot, "harness.lock.json"),
        `${JSON.stringify(
          {
            schemaVersion: HARNESS_LOCK_SCHEMA_VERSION,
            harnessVersion: HARNESS_VERSION,
            registryVersion: "v1",
            lockProtocolVersion: LOCK_PROTOCOL_VERSION,
            technologies: {},
          },
          null,
          2,
        )}\n`,
      ),
      atomicWriteStateFile(
        this.projectRoot,
        join(this.stateRoot, "active-run.json"),
        `${JSON.stringify({ runId: null, updatedAt: now }, null, 2)}\n`,
      ),
      atomicWriteStateFile(this.projectRoot, join(this.stateRoot, "decisions.jsonl"), ""),
      atomicWriteStateFile(this.projectRoot, join(this.stateRoot, "evidence/index.jsonl"), ""),
    ])
    return config
  }

  async readConfig(): Promise<ProjectConfig> {
    await assertSafeStateFile(this.projectRoot, join(this.stateRoot, "config.json"))
    return ProjectConfigSchema.parse(
      JSON.parse(await readFile(join(this.stateRoot, "config.json"), "utf8")),
    )
  }

  async activeRun(): Promise<ActiveRun> {
    await assertSafeStateFile(this.projectRoot, join(this.stateRoot, "active-run.json"))
    return ActiveRunSchema.parse(
      JSON.parse(await readFile(join(this.stateRoot, "active-run.json"), "utf8")),
    )
  }

  async createRun(manifest: RunManifest): Promise<void> {
    await this.manifests.create(manifest)
    await atomicWriteStateFile(
      this.projectRoot,
      join(this.stateRoot, "active-run.json"),
      `${JSON.stringify(
        {
          runId: manifest.runId,
          updatedAt: manifest.updatedAt,
        },
        null,
        2,
      )}\n`,
    )
  }

  async loadManifest(runId: string): Promise<RunManifest> {
    return this.manifests.load(runId)
  }

  async loadActiveManifest(): Promise<RunManifest> {
    const active = await this.activeRun()
    if (!active.runId) throw new ProjectStateError("No active run")
    return this.loadManifest(active.runId)
  }

  async saveManifest(
    manifest: RunManifest,
    expectedGeneration = manifest.generation,
  ): Promise<void> {
    await this.manifests.save(manifest, expectedGeneration)
  }

  async invalidateFrom(stage: PipelineStage, now = new Date().toISOString()): Promise<RunManifest> {
    const active = await this.activeRun()
    if (!active.runId) throw new ProjectStateError("No active run")
    return this.manifests.invalidate(active.runId, stage, now)
  }

  async reconcileDecisionEvents(
    events: readonly DecisionRecord[],
    now = new Date().toISOString(),
  ): Promise<RunManifest | undefined> {
    const active = await this.activeRun()
    if (active.runId === null) return undefined
    return this.manifests.reconcile(active.runId, events, now)
  }

  async lockProtocolHealth(): Promise<LockProtocolHealth> {
    return inspectLockProtocol(this.projectRoot, this.stateRoot)
  }

  async upgrade(now = new Date().toISOString()): Promise<UpgradeResult> {
    const before = await this.lockProtocolHealth()
    if (
      before.status === "active-legacy-lock" ||
      before.status === "recovery-required" ||
      before.status === "unsupported-protocol"
    ) {
      return { status: "blocked", lockProtocol: before }
    }
    const config = await this.readConfig()
    const upgraded = { ...config, harnessVersion: HARNESS_VERSION, updatedAt: now }
    const harnessLock = upgradeHarnessLock(
      await readHarnessLock(this.projectRoot, this.stateRoot),
      HARNESS_VERSION,
    )
    await Promise.all([
      atomicWriteStateFile(
        this.projectRoot,
        join(this.stateRoot, "config.json"),
        `${JSON.stringify(upgraded, null, 2)}\n`,
      ),
      atomicWriteStateFile(
        this.projectRoot,
        join(this.stateRoot, "harness.lock.json"),
        `${JSON.stringify(harnessLock, null, 2)}\n`,
      ),
    ])
    return { status: "upgraded", config: upgraded, lockProtocol: await this.lockProtocolHealth() }
  }

  async readEvidenceLines(): Promise<string[]> {
    const path = join(this.stateRoot, "evidence/index.jsonl")
    await assertSafeStateFile(this.projectRoot, path)
    const value = await readFile(path, "utf8")
    return value.split("\n").filter(Boolean)
  }
}
