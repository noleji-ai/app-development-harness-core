import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"

import { type PipelineStage, PipelineStageSchema, type RunManifest } from "../domain/manifest"
import type { StageResult } from "../engine/pipeline"
import { atomicWriteStateFile } from "../state/atomic-state-file"
import type { ProjectStore } from "../state/project-store"
import { assertSafeStateFile } from "../state/safe-path"
import type { CodexStageOutput } from "./stage-contract"
import { usageMatches } from "./usage-receipt"
import { workspaceDigest } from "./workspace-digest"

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
const ArtifactCheckpointSchema = z
  .object({ id: z.string().min(1), path: z.string().min(1), sha256: z.string().length(64) })
  .strict()
const StageResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("completed"),
      outputHash: z.string(),
      evidenceIds: z.array(z.string()),
      adapterId: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("blocked"), decisionIds: z.array(z.string()).max(3) }).strict(),
  z.object({ kind: z.literal("failed"), error: z.string() }).strict(),
  z.object({ kind: z.literal("unverified"), missingCapabilities: z.array(z.string()) }).strict(),
])
export const CheckpointSchema = z
  .object({
    schemaVersion: z.literal(3),
    sourceHash: z.string().length(64),
    policyHash: z.string().length(64),
    finalStageOutputHash: z.string().optional(),
    usageRef: z
      .string()
      .regex(/^model-execution-[a-f0-9]{64}\.json$/)
      .optional(),
    usageHash: z.string().length(64).optional(),
    runId: z.string(),
    stage: PipelineStageSchema,
    inputHash: z.string(),
    transport: z.enum(["exec", "app-server"]),
    transcriptHash: z.string().length(64),
    artifacts: z.array(ArtifactCheckpointSchema),
    result: StageResultSchema,
    completedAt: z.iso.datetime(),
  })
  .strict()

export type ArtifactCheckpoint = z.infer<typeof ArtifactCheckpointSchema>
export type CompletedCheckpoint = z.infer<typeof CheckpointSchema>

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function contained(root: string, target: string): boolean {
  const route = relative(root, target)
  return route === "" || (route !== ".." && !route.startsWith(`..${sep}`))
}

async function verifyArtifact(
  projectRoot: string,
  localId: string,
  value: { path: string },
): Promise<ArtifactCheckpoint> {
  if (
    value.path.includes("\0") ||
    isAbsolute(value.path) ||
    value.path === ".app-harness" ||
    value.path.startsWith(".app-harness/")
  ) {
    throw new Error("model evidence path is unsafe")
  }
  const lexicalRoot = resolve(projectRoot)
  const path = resolve(lexicalRoot, value.path)
  if (!contained(lexicalRoot, path) || path === lexicalRoot) {
    throw new Error("evidence escaped project")
  }
  const state = await lstat(path)
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    state.size > MAX_ARTIFACT_BYTES
  ) {
    throw new Error("evidence must be a bounded non-symlink regular file")
  }
  const root = await realpath(lexicalRoot)
  if (!contained(root, await realpath(path))) throw new Error("evidence escaped project")
  return { id: localId, path: relative(lexicalRoot, path), sha256: digest(await readFile(path)) }
}

export async function verifyArtifacts(
  projectRoot: string,
  output: CodexStageOutput,
): Promise<ArtifactCheckpoint[]> {
  const artifacts = await Promise.all(
    output.evidence.map((item) => verifyArtifact(projectRoot, item.id, item)),
  )
  if (new Set(artifacts.map((item) => item.path)).size !== artifacts.length) {
    throw new Error("Codex result repeats an evidence path")
  }
  return artifacts
}

function evidenceId(runId: string, stage: PipelineStage, artifact: ArtifactCheckpoint): string {
  return `codex:${runId}:${stage}:${artifact.id}:${artifact.sha256.slice(0, 16)}`
}

export function toStageResult(
  output: CodexStageOutput,
  artifacts: readonly ArtifactCheckpoint[],
  bridgeId: string,
  adapterId: string | undefined,
  diagnostic: (value: unknown) => string,
): StageResult {
  switch (output.status) {
    case "blocked":
      return { kind: "blocked", decisionIds: output.decisionIds }
    case "failed":
      return { kind: "failed", error: diagnostic(output.error) }
    case "unverified":
      return { kind: "unverified", missingCapabilities: output.missingCapabilities }
    case "completed":
      return {
        kind: "completed",
        outputHash: digest(canonical({ output, artifacts })),
        evidenceIds: [
          ...artifacts.map((artifact) => evidenceId(output.runId, output.stage, artifact)),
          bridgeId,
        ],
        ...(adapterId === undefined ? {} : { adapterId }),
      }
  }
}

export async function validCheckpoint(
  store: ProjectStore,
  path: string,
  expected: { runId: string; stage: PipelineStage; inputHash: string },
): Promise<CompletedCheckpoint | undefined> {
  await assertSafeStateFile(store.projectRoot, path)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined
    }
    throw error
  }
  const parsed = CheckpointSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const checkpoint = parsed.data
  if (!checkpoint.usageRef || !checkpoint.usageHash) return undefined
  const usagePath = join(store.stateRoot, "evidence", checkpoint.usageRef)
  await assertSafeStateFile(store.projectRoot, usagePath)
  try {
    const content = await readFile(usagePath, "utf8")
    if (
      digest(content) !== checkpoint.usageHash ||
      !usageMatches(content, { ...checkpoint, usageRef: checkpoint.usageRef })
    )
      return undefined
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
  if (checkpoint.sourceHash !== (await workspaceDigest(store.projectRoot))) return undefined
  if (
    checkpoint.runId !== expected.runId ||
    checkpoint.stage !== expected.stage ||
    checkpoint.inputHash !== expected.inputHash
  ) {
    return undefined
  }
  for (const artifact of checkpoint.artifacts) {
    const verified = await verifyArtifact(store.projectRoot, artifact.id, artifact)
    if (verified.sha256 !== artifact.sha256) return undefined
  }
  return checkpoint
}

export async function writeCheckpoint(
  store: ProjectStore,
  path: string,
  checkpoint: CompletedCheckpoint,
): Promise<void> {
  await atomicWriteStateFile(store.projectRoot, path, `${JSON.stringify(checkpoint, null, 2)}\n`)
}

export async function bindCheckpointUsage(
  store: ProjectStore,
  path: string,
  usage: { usageRef: string; usageHash: string },
): Promise<void> {
  await assertSafeStateFile(store.projectRoot, path)
  const checkpoint = CheckpointSchema.parse(JSON.parse(await readFile(path, "utf8")))
  await writeCheckpoint(store, path, { ...checkpoint, ...usage })
}

export async function sealRunCheckpoints(
  store: ProjectStore,
  manifest: RunManifest,
): Promise<void> {
  const directory = join(store.stateRoot, "evidence")
  const sourceHash = await workspaceDigest(store.projectRoot)
  for (const name of await readdir(directory)) {
    if (!/^codex-[a-f0-9]{64}\.checkpoint\.json$/.test(name)) continue
    const path = join(directory, name)
    await assertSafeStateFile(store.projectRoot, path)
    const parsed = CheckpointSchema.safeParse(JSON.parse(await readFile(path, "utf8")))
    if (!parsed.success || parsed.data.runId !== manifest.runId) continue
    const state = manifest.stages[parsed.data.stage]
    if (
      state.kind !== "completed" ||
      state.inputHash !== parsed.data.inputHash ||
      parsed.data.result.kind !== "completed" ||
      state.outputHash.split(":")[0] !== parsed.data.result.outputHash
    )
      continue
    for (const artifact of parsed.data.artifacts) {
      const current = await verifyArtifact(store.projectRoot, artifact.id, artifact)
      if (current.sha256 !== artifact.sha256)
        throw new Error("checkpoint artifact changed after its stage")
    }
    await writeCheckpoint(store, path, {
      ...parsed.data,
      sourceHash,
      finalStageOutputHash: state.outputHash,
    })
  }
}
