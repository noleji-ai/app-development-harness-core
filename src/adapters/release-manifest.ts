import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { atomicWriteStateFile } from "../state/atomic-state-file"
import { writeArtifacts } from "./artifact-writer"
import type { AdapterContext, AdapterOutputArtifact, AdapterResult } from "./contract"
import { findUnsafeArtifactDirectory } from "./macos-paths"
import type { AdapterCommand, OfficialAdapterSpec } from "./official-types"

export async function writeReleaseManifest(
  context: AdapterContext,
  spec: OfficialAdapterSpec,
  commands: readonly AdapterCommand[],
): Promise<AdapterResult | undefined> {
  const route = join(".app-harness", "releases", spec.id)
  const contents = `${JSON.stringify(
    {
      adapterId: spec.id,
      adapterVersion: spec.version,
      observedAt: spec.observedAt,
      providerNeutral: true,
      signed: false,
      commands,
    },
    null,
    2,
  )}\n`
  return writeArtifacts(context, [{ path: join(route, "manifest.json"), contents }])
}

export async function prepareReleaseDirectory(
  context: AdapterContext,
  spec: OfficialAdapterSpec,
): Promise<string> {
  const route = join(".app-harness", "releases", spec.id)
  const unsafe = await findUnsafeArtifactDirectory(context.projectRoot, [
    join(route, "manifest.json"),
  ])
  if (unsafe !== undefined) throw new Error(`unsafe release path: ${unsafe}`)
  const directory = join(context.projectRoot, route)
  await mkdir(directory, { recursive: true })
  return directory
}

export async function verifyPackageRoundTrip(
  context: AdapterContext,
  spec: OfficialAdapterSpec,
  outputs: readonly AdapterOutputArtifact[],
): Promise<{ readonly source: string; readonly sha256: string; readonly bytes: number }> {
  const source = outputs.toSorted((left, right) => left.size - right.size)[0]
  if (source === undefined) throw new Error("package roundtrip lacks a source artifact")
  const contents = await readFile(resolve(context.projectRoot, source.path))
  const hash = createHash("sha256").update(contents).digest("hex")
  if (hash !== source.sha256) throw new Error("package roundtrip source hash mismatch")
  const release = join(context.projectRoot, ".app-harness", "releases", spec.id)
  const probe = join(release, "roundtrip-probe.bin")
  await atomicWriteStateFile(context.projectRoot, probe, contents)
  const restored = await readFile(probe)
  const restoredHash = createHash("sha256").update(restored).digest("hex")
  if (!restored.equals(contents) || restoredHash !== hash) {
    throw new Error("package roundtrip restore mismatch")
  }
  const report = { source: source.path, sha256: hash, bytes: contents.byteLength }
  await atomicWriteStateFile(
    context.projectRoot,
    join(release, "roundtrip.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  return report
}
