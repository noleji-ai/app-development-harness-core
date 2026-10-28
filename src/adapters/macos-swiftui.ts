import { execFile } from "node:child_process"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

import {
  assertCleanGitWorkspace,
  WorkspaceDirtyError,
  WorkspaceNotGitError,
} from "../state/workspace-guard"
import type { AdapterContext, AdapterResult, AppAdapter } from "./contract"
import { findUnsafeArtifactDirectory } from "./macos-paths"
import { MACOS_APP_NAME, MACOS_ARTIFACTS } from "./macos-swiftui-artifacts"
import { selectMacosTestScheme } from "./macos-xcode-schemes"

const ADAPTER_VERSION = "1.0.0"
const XCODE_VERSION = "26.6"
const REGISTRY_OBSERVED_AT = "2026-07-13"
const CAPABILITIES = ["build", "test", "manual-qa", "deploy-ready", "macos-app", "swiftui"] as const
type CommandOutcome =
  | { readonly kind: "completed"; readonly stdout: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed" }

function result(
  status: AdapterResult["status"],
  summary: string,
  args: readonly string[],
): AdapterResult {
  return { status, summary, commands: [{ executable: "xcodebuild", args }] }
}

function resultWithCommands(
  status: AdapterResult["status"],
  summary: string,
  commands: readonly (readonly string[])[],
): AdapterResult {
  return {
    status,
    summary,
    commands: commands.map((args) => ({ executable: "xcodebuild", args })),
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = Reflect.get(error, "code")
  return typeof code === "string" ? code : undefined
}

async function existingContents(path: string): Promise<string | undefined> {
  try {
    const state = await lstat(path)
    if (!state.isFile() || state.isSymbolicLink()) return undefined
    return await readFile(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

function runXcode(projectRoot: string, args: readonly string[]): Promise<CommandOutcome> {
  const pathValue = Reflect.get(process.env, "PATH")
  const path = typeof pathValue === "string" ? pathValue : ""
  return new Promise((resolveCommand) => {
    execFile(
      "xcodebuild",
      [...args],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: { PATH: path },
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error === null) resolveCommand({ kind: "completed", stdout })
        else if (errorCode(error) === "ENOENT") resolveCommand({ kind: "unavailable" })
        else resolveCommand({ kind: "failed" })
      },
    )
  })
}

function verificationArgs(
  projectRoot: string,
  scheme: string,
  operation: "build" | "test",
): readonly string[] {
  return [
    "-scheme",
    scheme,
    "-destination",
    "platform=macOS",
    "-derivedDataPath",
    join(projectRoot, ".app-harness", "xcode-derived"),
    operation,
  ]
}

async function verifyBuildWithXcode(projectRoot: string): Promise<AdapterResult> {
  const operation = "build"
  const args = verificationArgs(projectRoot, MACOS_APP_NAME, operation)
  if ((await existingContents(join(projectRoot, "Package.swift"))) === undefined) {
    return result("unverified", `macOS scaffold unavailable; ${operation} not verified`, args)
  }
  const outcome = await runXcode(projectRoot, args)
  switch (outcome.kind) {
    case "completed":
      return result("passed", `macOS ${operation} passed`, args)
    case "unavailable":
      return result("unverified", `xcodebuild unavailable; macOS ${operation} not verified`, args)
    case "failed":
      return result("blocked", `macOS ${operation} failed`, args)
  }
}

async function verifyTestWithXcode(projectRoot: string): Promise<AdapterResult> {
  const listArgs = ["-list", "-json"] as const
  const listedCommands = [listArgs] as const
  if ((await existingContents(join(projectRoot, "Package.swift"))) === undefined) {
    return resultWithCommands(
      "unverified",
      "macOS scaffold unavailable; test not verified",
      listedCommands,
    )
  }
  const listOutcome = await runXcode(projectRoot, listArgs)
  if (listOutcome.kind === "unavailable") {
    return resultWithCommands(
      "unverified",
      "xcodebuild unavailable; macOS test not verified",
      listedCommands,
    )
  }
  if (listOutcome.kind === "failed") {
    return resultWithCommands("blocked", "macOS test scheme discovery failed", listedCommands)
  }
  const scheme = selectMacosTestScheme(listOutcome.stdout)
  if (scheme === undefined) {
    return resultWithCommands(
      "unverified",
      "no supported test-capable scheme was discovered; macOS test not verified",
      listedCommands,
    )
  }
  const args = verificationArgs(projectRoot, scheme, "test")
  const commands = [listArgs, args] as const
  const outcome = await runXcode(projectRoot, args)
  switch (outcome.kind) {
    case "completed":
      return resultWithCommands("passed", `macOS test passed with scheme ${scheme}`, commands)
    case "unavailable":
      return resultWithCommands(
        "unverified",
        "xcodebuild unavailable; macOS test not verified",
        commands,
      )
    case "failed":
      return resultWithCommands("blocked", `macOS test failed with scheme ${scheme}`, commands)
  }
}

async function validateScaffoldRoot(context: AdapterContext): Promise<AdapterResult | undefined> {
  if (context.mode === "extend") {
    try {
      await assertCleanGitWorkspace(context.projectRoot)
    } catch (error) {
      if (error instanceof WorkspaceDirtyError || error instanceof WorkspaceNotGitError) {
        return result("blocked", error.message, ["-version"])
      }
      throw error
    }
  }
  await mkdir(context.projectRoot, { recursive: true })
  if ((await lstat(context.projectRoot)).isSymbolicLink()) {
    return result("blocked", "macOS scaffold root must not be a symlink", ["-version"])
  }
  const unsafeDirectory = await findUnsafeArtifactDirectory(
    context.projectRoot,
    MACOS_ARTIFACTS.map((artifact) => artifact.path),
  )
  if (unsafeDirectory !== undefined) {
    return result("blocked", `unsafe macOS scaffold path: ${unsafeDirectory}`, ["-version"])
  }
  return undefined
}

export const MACOS_SWIFTUI_ADAPTER: AppAdapter = {
  id: "macos-swiftui",
  platform: "macos",
  version: ADAPTER_VERSION,
  capabilities: CAPABILITIES,
  async detect(context) {
    const found = await existingContents(join(context.projectRoot, "Package.swift"))
    return found?.includes(`name: "${MACOS_APP_NAME}"`)
      ? result("passed", "detected SwiftUI macOS package", ["-version"])
      : result("unverified", "SwiftUI macOS package not detected", ["-version"])
  },
  async plan(context) {
    const lock = context.compatibilityLock
    if (
      lock !== undefined &&
      (lock.adapterVersion !== ADAPTER_VERSION ||
        lock.xcodeVersion !== XCODE_VERSION ||
        lock.observedAt < REGISTRY_OBSERVED_AT)
    ) {
      return result("blocked", "compatibility registry lock is stale or incompatible", ["-version"])
    }
    const gap = context.requestedCapabilities.find(
      (item) => !CAPABILITIES.some((capability) => capability === item),
    )
    return gap === undefined
      ? result("passed", "macOS SwiftUI artifact plan ready", ["-version"])
      : result("blocked", `capability_extension_required: ${gap}`, ["-version"])
  },
  async scaffold(context) {
    const invalid = await validateScaffoldRoot(context)
    if (invalid !== undefined) return invalid
    for (const artifact of MACOS_ARTIFACTS) {
      const target = resolve(context.projectRoot, artifact.path)
      const route = relative(resolve(context.projectRoot), target)
      if (route === "" || route === ".." || route.startsWith(`..${sep}`)) {
        return result("blocked", "macOS scaffold path escaped project root", ["-version"])
      }
      const current = await existingContents(target)
      if (current !== undefined && current !== artifact.contents) {
        return result("blocked", `existing file conflict: ${artifact.path}`, ["-version"])
      }
    }
    for (const artifact of MACOS_ARTIFACTS) {
      const target = join(context.projectRoot, artifact.path)
      if ((await existingContents(target)) !== undefined) continue
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, artifact.contents, { flag: "wx", mode: 0o600 })
    }
    return result("passed", "macOS SwiftUI artifact scaffolded", ["-version"])
  },
  build: (context) => verifyBuildWithXcode(context.projectRoot),
  test: (context) => verifyTestWithXcode(context.projectRoot),
  async manualQa(context) {
    const build = await verifyBuildWithXcode(context.projectRoot)
    return build.status === "passed"
      ? result("unverified", "interactive macOS surface QA is still required", ["-version"])
      : build
  },
  async packageDeployReady(context) {
    const args = ["-version"] as const
    if ((await existingContents(join(context.projectRoot, "Package.swift"))) === undefined) {
      return result("unverified", "macOS scaffold unavailable; release bundle not verified", args)
    }
    const outcome = await runXcode(context.projectRoot, args)
    if (outcome.kind === "unavailable") {
      return result("unverified", "xcodebuild unavailable; release bundle not verified", args)
    }
    if (outcome.kind === "failed") return result("blocked", "xcodebuild version probe failed", args)
    if (!outcome.stdout.includes(`Xcode ${XCODE_VERSION}`)) {
      return result("unverified", `Xcode ${XCODE_VERSION} registry lock is not satisfied`, args)
    }
    return result("unverified", "signing and notarization evidence is required", args)
  },
}
