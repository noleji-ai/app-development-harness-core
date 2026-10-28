import { join } from "node:path"
import {
  assertCleanGitWorkspace,
  WorkspaceDirtyError,
  WorkspaceNotGitError,
} from "../state/workspace-guard"
import { collectOutputArtifacts } from "./adapter-output"
import { matchesMarker, writeArtifacts } from "./artifact-writer"
import { commandResult, runCommand } from "./command-runner"
import type { AdapterCommandReceipt, AdapterContext, AdapterResult, AppAdapter } from "./contract"
import type { AdapterCommand, OfficialAdapterSpec } from "./official-types"
import {
  prepareReleaseDirectory,
  verifyPackageRoundTrip,
  writeReleaseManifest,
} from "./release-manifest"
import {
  accessibilityAudit,
  discoverTestSources,
  parseNativeChecks,
  validateSemanticBuild,
} from "./semantic-evidence"

function withExecution(
  result: AdapterResult,
  commands: readonly AdapterCommand[],
  commandReceipts: readonly AdapterCommandReceipt[],
): AdapterResult {
  return { ...result, commands, commandReceipts }
}

async function execute(
  context: AdapterContext,
  spec: OfficialAdapterSpec,
  stage: "build" | "test" | "manualQa" | "package",
): Promise<AdapterResult> {
  if (!(await matchesMarker(context.projectRoot, spec.marker))) {
    return { status: "unverified", summary: `scaffold_missing: ${spec.id}; ${stage}`, commands: [] }
  }
  const toolchain = await verifyToolchain(context, spec)
  if (toolchain.status !== "passed") {
    return { ...toolchain, summary: `${toolchain.summary}; ${stage} not verified` }
  }
  const command = spec[stage]
  if (
    (stage === "test" || stage === "manualQa") &&
    (await discoverTestSources(context.projectRoot, spec)) < 1
  ) {
    return {
      status: "unverified",
      summary: `${spec.id} ${stage} discovered no test sources`,
      commands: toolchain.commands,
      ...(toolchain.commandReceipts === undefined
        ? {}
        : { commandReceipts: toolchain.commandReceipts }),
    }
  }
  const outcome = await runCommand(context, command)
  let stageResult = commandResult(outcome, `${spec.id} ${stage}`, command)
  if (stageResult.status === "passed" && (stage === "build" || stage === "package")) {
    const outputArtifacts = await collectOutputArtifacts(
      context.projectRoot,
      command.writablePaths ?? [],
    )
    const semanticFailure =
      outputArtifacts.length === 0
        ? `${spec.id} ${stage} produced no artifacts`
        : await validateSemanticBuild(context.projectRoot, spec, outputArtifacts, stage)
    stageResult =
      semanticFailure === undefined
        ? { ...stageResult, outputArtifacts }
        : {
            ...stageResult,
            status: "unverified",
            summary: `semantic_build_failed: ${semanticFailure}`,
          }
  }
  if (stageResult.status === "passed" && (stage === "test" || stage === "manualQa")) {
    const native = parseNativeChecks(spec, outcome.stdout)
    if (native === undefined) {
      stageResult = {
        ...stageResult,
        status: "unverified",
        summary: `${spec.id} ${stage} reported no structured native checks`,
      }
    } else {
      const accessibility =
        stage === "manualQa" ? await accessibilityAudit(context.projectRoot, spec) : undefined
      if (stage === "manualQa" && spec.platform !== "backend" && accessibility?.checks === 0) {
        stageResult = {
          ...stageResult,
          status: "unverified",
          summary: `${spec.id} manualQa failed distinct accessibility audit`,
        }
      } else {
        stageResult = {
          ...stageResult,
          executedChecks: native.checks,
          ...(accessibility === undefined || accessibility.checks === 0
            ? {}
            : { accessibilityChecks: accessibility.checks }),
        }
      }
    }
  }
  return withExecution(
    stageResult,
    [...toolchain.commands, ...stageResult.commands],
    [...(toolchain.commandReceipts ?? []), ...(stageResult.commandReceipts ?? [])],
  )
}

async function verifyToolchain(
  context: AdapterContext,
  spec: OfficialAdapterSpec,
): Promise<AdapterResult> {
  const outcome = await runCommand(context, spec.probe)
  const result = commandResult(outcome, `${spec.id} toolchain`, spec.probe)
  if (result.status !== "passed") return result
  if (spec.probeOutput !== undefined && !outcome.stdout.includes(spec.probeOutput)) {
    return {
      status: "unverified",
      summary: `toolchain_version_mismatch: expected ${spec.probeOutput}`,
      commands: [spec.probe],
      ...(result.commandReceipts === undefined ? {} : { commandReceipts: result.commandReceipts }),
    }
  }
  return result
}

async function scaffold(
  context: AdapterContext,
  spec: OfficialAdapterSpec,
): Promise<AdapterResult> {
  if (context.mode === "extend") {
    try {
      await assertCleanGitWorkspace(context.projectRoot)
    } catch (error) {
      if (error instanceof WorkspaceDirtyError || error instanceof WorkspaceNotGitError) {
        return { status: "blocked", summary: error.message, commands: [] }
      }
      throw error
    }
    if (!(await matchesMarker(context.projectRoot, spec.marker))) {
      return {
        status: "blocked",
        summary: `existing_stack_mismatch: ${spec.id}; explicit migration approval required`,
        commands: [],
      }
    }
  }
  const invalid = await writeArtifacts(context, spec.artifacts)
  if (invalid !== undefined) return invalid
  return { status: "passed", summary: `${spec.id} scaffold ready`, commands: [] }
}

async function packageReady(
  context: AdapterContext,
  spec: OfficialAdapterSpec,
): Promise<AdapterResult> {
  const commands: AdapterCommand[] = []
  const commandReceipts: AdapterCommandReceipt[] = []
  let outputArtifacts: AdapterResult["outputArtifacts"]
  let executedChecks = 0
  let accessibilityChecks = 0
  for (const stage of ["build", "test", "manualQa"] as const) {
    const gate = await execute(context, spec, stage)
    commands.push(...gate.commands)
    commandReceipts.push(...(gate.commandReceipts ?? []))
    outputArtifacts = gate.outputArtifacts ?? outputArtifacts
    executedChecks += gate.executedChecks ?? 0
    accessibilityChecks += gate.accessibilityChecks ?? 0
    if (gate.status !== "passed") {
      return withExecution(
        { ...gate, summary: `release_gate_${stage}: ${gate.summary}` },
        commands,
        commandReceipts,
      )
    }
  }
  try {
    await prepareReleaseDirectory(context, spec)
  } catch (error) {
    const summary = error instanceof Error ? error.message : "unsafe release path"
    return { status: "blocked", summary, commands, commandReceipts }
  }
  const packaged = await execute(context, spec, "package")
  commands.push(...packaged.commands)
  commandReceipts.push(...(packaged.commandReceipts ?? []))
  if (packaged.status !== "passed") return withExecution(packaged, commands, commandReceipts)
  outputArtifacts = packaged.outputArtifacts
  try {
    await verifyPackageRoundTrip(context, spec, outputArtifacts ?? [])
    const invalid = await writeReleaseManifest(context, spec, commands)
    if (invalid !== undefined) return withExecution(invalid, commands, commandReceipts)
    outputArtifacts = await collectOutputArtifacts(context.projectRoot, [
      join(".app-harness", "releases", spec.id),
    ])
  } catch (error) {
    const summary = error instanceof Error ? error.message : "release manifest failed"
    return { status: "blocked", summary, commands, commandReceipts }
  }
  return {
    status: "passed",
    summary: `${spec.id} provider-neutral package ready`,
    commands,
    commandReceipts,
    ...(outputArtifacts === undefined ? {} : { outputArtifacts }),
    executedChecks,
    ...(accessibilityChecks === 0 ? {} : { accessibilityChecks }),
  }
}

export function createConcreteAdapter(spec: OfficialAdapterSpec): AppAdapter {
  return {
    id: spec.id,
    platform: spec.platform,
    version: spec.version,
    capabilities: spec.capabilities,
    async detect(context) {
      if (!(await matchesMarker(context.projectRoot, spec.marker))) {
        return {
          status: "unverified",
          summary: `${spec.id} project not detected`,
          commands: [spec.probe],
        }
      }
      return verifyToolchain(context, spec)
    },
    async plan(context) {
      const lock = context.compatibilityLock
      if (
        lock !== undefined &&
        (lock.adapterVersion !== spec.version ||
          lock.observedAt < spec.observedAt ||
          (spec.requiredXcodeVersion !== undefined &&
            lock.xcodeVersion !== spec.requiredXcodeVersion))
      ) {
        return {
          status: "blocked",
          summary: `compatibility registry migration required: ${spec.id}`,
          commands: [spec.probe],
        }
      }
      const gap = context.requestedCapabilities.find((item) => !spec.capabilities.includes(item))
      return gap === undefined
        ? { status: "passed", summary: `${spec.id} plan ready`, commands: [spec.probe] }
        : {
            status: "blocked",
            summary: `capability_extension_required: ${gap}`,
            commands: [spec.probe],
          }
    },
    scaffold: (context) => scaffold(context, spec),
    build: (context) => execute(context, spec, "build"),
    test: (context) => execute(context, spec, "test"),
    manualQa: (context) => execute(context, spec, "manualQa"),
    packageDeployReady: (context) => packageReady(context, spec),
  }
}
