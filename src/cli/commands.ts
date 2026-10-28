import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { launchDashboard } from "../dashboard/launcher"
import {
  DEFAULT_DESIGN_POLICY,
  explicitDesignPolicy,
  resolveDesignPolicy,
} from "../domain/design-policy"
import { createManifest } from "../domain/manifest.js"
import { collectRunArtifact } from "../execution/artifact-collection"
import { runnerReceiptLines } from "../execution/runner-adapter-receipt"
import { createTrustedAdapterSession } from "../execution/trusted-adapter-executor"
import { routeUserPrompt } from "../hooks/prompt-router.js"
import { assessReadiness, REQUIRED_RELEASE_CHECK_IDS } from "../release/readiness.js"
import { DecisionLedger } from "../state/decision-ledger"
import { LOCK_PROTOCOL_VERSION } from "../state/lock-compatibility.js"
import { HARNESS_VERSION, ProjectStore } from "../state/project-store.js"
import { flag, option, parseMode, parseWorkflowProfile } from "./arguments"
import {
  CLI_HELP,
  type CliIo,
  type CliServices,
  CliUsageError,
  isPublicCommand,
  type PublicCommand,
} from "./contracts"
import { runPipeline } from "./gates"
import { parseExplicitDesignPolicy, resolveRunInput } from "./request-input"
import { assertRunCorrelation } from "./run-correlation"

function pluginRoot(): string {
  const directory = dirname(fileURLToPath(import.meta.url))
  return directory.endsWith("/dist") ? resolve(directory, "..") : resolve(directory, "../..")
}

function json(io: CliIo, value: unknown): void {
  io.stdout(JSON.stringify(value))
}

async function pipelineJson(
  io: CliIo,
  store: ProjectStore,
  result: Awaited<ReturnType<typeof runPipeline>>,
) {
  if (result.manifest.releaseReady) {
    for (const line of await runnerReceiptLines(store)) io.stdout(line)
  }
  json(io, result)
}

async function status(store: ProjectStore): Promise<unknown> {
  const active = await store.activeRun()
  if (active.runId === null) return { initialized: true, activeRun: null }
  const manifest = await store.loadManifest(active.runId)
  return {
    initialized: true,
    activeRun: active.runId,
    stage: manifest.currentStage,
    state: manifest.stages[manifest.currentStage].kind,
    designPolicy: manifest.designPolicy,
    workflowProfile: manifest.workflowProfile,
    releaseReady: manifest.releaseReady,
  }
}

function assertNever(value: never): never {
  throw new CliUsageError(`Unsupported command: ${String(value)}`)
}

async function dispatchCommand(
  command: PublicCommand,
  argv: readonly string[],
  io: CliIo,
  services: CliServices,
): Promise<void> {
  const projectRoot = resolve(option(argv, "--project") ?? process.cwd())
  const store = new ProjectStore(projectRoot)
  const now = services.now?.() ?? new Date().toISOString()
  switch (command) {
    case "init": {
      const selected = parseExplicitDesignPolicy(argv)
      const config = await store.initialize(
        parseMode(option(argv, "--mode")),
        now,
        selected === undefined ? DEFAULT_DESIGN_POLICY : explicitDesignPolicy(selected),
      )
      json(io, { status: "initialized", projectRoot, config })
      return
    }
    case "run": {
      const mode = parseMode(option(argv, "--mode"))
      if (mode === "resume") throw new CliUsageError("Use the resume command for an existing run")
      const input = await resolveRunInput(projectRoot, argv)
      const requested =
        input.designPolicy === undefined
          ? DEFAULT_DESIGN_POLICY
          : explicitDesignPolicy(input.designPolicy)
      const config = await store.initialize(mode, now, requested)
      const designPolicy = resolveDesignPolicy(
        input.request,
        input.designPolicy,
        config.designPolicy,
      )
      const manifest = createManifest(
        option(argv, "--run-id") ?? services.runId?.() ?? `run-${Date.now()}`,
        mode,
        input.request,
        now,
        designPolicy,
        parseWorkflowProfile(option(argv, "--workflow-profile")) ?? config.workflowProfileDefault,
      )
      await store.createRun(manifest)
      await pipelineJson(io, store, await runPipeline(store, manifest, services))
      return
    }
    case "resume": {
      await assertRunCorrelation(store, argv)
      const ledger = new DecisionLedger(projectRoot)
      const manifest =
        (await store.reconcileDecisionEvents(await ledger.events(), now)) ??
        (await store.loadActiveManifest())
      await pipelineJson(io, store, await runPipeline(store, manifest, services))
      return
    }
    case "status": {
      await assertRunCorrelation(store, argv)
      const artifactId = option(argv, "--artifact-id")
      if (artifactId !== undefined) {
        const runId = option(argv, "--run-id")
        if (!runId) throw new CliUsageError("Artifact collection requires --run-id")
        json(io, await collectRunArtifact(store, runId, artifactId))
        return
      }
      json(io, await status(store))
      return
    }
    case "verify": {
      await assertRunCorrelation(store, argv)
      const active = await store.activeRun()
      if (active.runId === null) {
        json(io, assessReadiness([], REQUIRED_RELEASE_CHECK_IDS))
        return
      }
      const manifest = await store.loadManifest(active.runId)
      manifest.releaseReady = false
      await store.saveManifest(manifest)
      const session = createTrustedAdapterSession({
        store,
        ...(services.adapters === undefined ? {} : { adapters: services.adapters }),
        ...(services.adapterToolchainPath === undefined
          ? {}
          : { toolchainPath: services.adapterToolchainPath }),
        ...(services.adapterExecutionEnvironment === undefined
          ? {}
          : { executionEnvironment: services.adapterExecutionEnvironment }),
      })
      await session.execute("deploy-ready", manifest)
      const assessment = assessReadiness(session.readinessChecks(), REQUIRED_RELEASE_CHECK_IDS)
      manifest.releaseReady = assessment.ready
      await store.saveManifest(manifest)
      json(io, assessment)
      return
    }
    case "dashboard": {
      const result = services.dashboard
        ? await services.dashboard(projectRoot, flag(argv, "--open"))
        : await launchDashboard({
            projectRoot,
            pluginRoot: pluginRoot(),
            open: flag(argv, "--open"),
          })
      json(io, { url: result.url, snapshot: result.snapshot })
      return
    }
    case "doctor": {
      const config = await store.readConfig().catch(() => undefined)
      const lockProtocol =
        config === undefined
          ? {
              version: LOCK_PROTOCOL_VERSION,
              status: "uninitialized",
              metadata: "invalid",
              fences: 0,
              blockers: [],
            }
          : await store.lockProtocolHealth()
      json(io, {
        ok: config !== undefined && lockProtocol.status === "compatible",
        node: process.version,
        harness: HARNESS_VERSION,
        projectRoot,
        lockProtocol,
      })
      return
    }
    case "upgrade":
      json(io, await store.upgrade(now))
      return
    default:
      return assertNever(command)
  }
}

export async function executeCli(
  argv: readonly string[],
  io: CliIo = { stdout: console.log, stderr: console.error },
  services: CliServices = {},
): Promise<number> {
  const [command, subcommand, ...rest] = argv
  if (command === "--help" || command === "-h") {
    io.stdout(CLI_HELP)
    return 0
  }
  if (command === "hook") {
    if (subcommand !== "user-prompt-submit") {
      throw new CliUsageError(`Unknown hook: ${subcommand ?? ""}`)
    }
    json(io, routeUserPrompt(rest.join(" ")))
    return 0
  }
  if (!isPublicCommand(command)) throw new CliUsageError(`Unknown command: ${command ?? ""}`)
  await dispatchCommand(command, argv, io, services)
  return 0
}
