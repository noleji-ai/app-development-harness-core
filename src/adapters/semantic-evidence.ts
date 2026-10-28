import { access, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import type { AdapterOutputArtifact } from "./contract"
import type { OfficialAdapterSpec } from "./official-types"

type NativeCheckReport = {
  readonly checks: number
  readonly format: "bun" | "go-json" | "gradle" | "unittest" | "xcode"
}

async function readable(projectRoot: string, path: string): Promise<Buffer | undefined> {
  try {
    const file = join(projectRoot, path)
    const state = await stat(file)
    if (!state.isFile() || state.size < 1) return undefined
    return await readFile(file)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined
    }
    throw error
  }
}

async function contains(projectRoot: string, path: string, token: string): Promise<boolean> {
  const contents = await readable(projectRoot, path)
  return contents?.toString("utf8").includes(token) ?? false
}

export async function discoverTestSources(
  projectRoot: string,
  spec: OfficialAdapterSpec,
): Promise<number> {
  let discovered = 0
  for (const path of spec.testSources) {
    try {
      await access(join(projectRoot, path))
      const contents = await readable(projectRoot, path)
      if (contents !== undefined) discovered += 1
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      ) {
        throw error
      }
    }
  }
  return discovered
}

function positive(match: RegExpMatchArray | null): number | undefined {
  const count = Number(match?.[1])
  return Number.isSafeInteger(count) && count > 0 ? count : undefined
}

export function parseNativeChecks(
  spec: OfficialAdapterSpec,
  output: string,
): NativeCheckReport | undefined {
  if (/HARNESS_(?:TESTS|QA|ACCESSIBILITY)_PASSED/.test(output)) return undefined
  if (spec.id === "backend-go-postgres") {
    let checks = 0
    for (const line of output.split("\n")) {
      try {
        const event = JSON.parse(line) as { Action?: unknown; Test?: unknown }
        if (event.Action === "fail" && typeof event.Test === "string") return undefined
        if (event.Action === "pass" && typeof event.Test === "string") checks += 1
      } catch {
        // Go may prefix its JSON stream with tool version diagnostics.
      }
    }
    return checks > 0 ? { checks, format: "go-json" } : undefined
  }
  if (spec.id === "backend-fastapi-postgres") {
    if (!/(?:^|\n)OK(?:\s|$)/.test(output) || /FAILED|ERROR/.test(output)) return undefined
    const checks = positive(output.match(/Ran\s+(\d+)\s+tests?\b/))
    return checks === undefined ? undefined : { checks, format: "unittest" }
  }
  if (spec.platform === "ios") {
    const match = output.match(/Executed\s+(\d+)\s+tests?,\s+with\s+(\d+)\s+failures?\b/i)
    const checks = positive(match)
    return checks === undefined || Number(match?.[2]) !== 0
      ? undefined
      : { checks, format: "xcode" }
  }
  if (spec.platform === "android") {
    const match = output.match(/(\d+)\s+tests?\s+completed,\s+(\d+)\s+failed\b/i)
    const checks = positive(match)
    return checks === undefined || Number(match?.[2]) !== 0
      ? undefined
      : { checks, format: "gradle" }
  }
  const checks = positive(output.match(/(?:^|\s)(\d+)\s+pass(?:ed)?\b/i))
  const failed = Number(output.match(/(?:^|\s)(\d+)\s+fail(?:ed)?\b/i)?.[1] ?? "0")
  return checks === undefined || failed !== 0 ? undefined : { checks, format: "bun" }
}

function paths(artifacts: readonly AdapterOutputArtifact[]): string[] {
  return artifacts.map((artifact) => artifact.path)
}

export async function validateSemanticBuild(
  projectRoot: string,
  spec: OfficialAdapterSpec,
  artifacts: readonly AdapterOutputArtifact[],
  stage: "build" | "package",
): Promise<string | undefined> {
  const outputPaths = paths(artifacts)
  if (spec.id === "web-next") {
    const manifest = await readable(projectRoot, ".next/build-manifest.json")
    if (manifest === undefined) return "missing structured Next build manifest"
    try {
      JSON.parse(manifest.toString("utf8"))
    } catch {
      return "invalid structured Next build manifest"
    }
    if (!(await contains(projectRoot, ".next/server/app/index.html", "<main"))) {
      return "Next production surface smoke failed"
    }
  } else if (spec.id === "web-astro") {
    if (!(await contains(projectRoot, "dist/index.html", "<main"))) return "Astro HTML smoke failed"
  } else if (spec.id === "web-vite-react-pwa") {
    if (!(await contains(projectRoot, "dist/index.html", 'id="root"')))
      return "Vite HTML smoke failed"
    if (!outputPaths.some((path) => /^dist\/assets\/.+\.js$/.test(path)))
      return "Vite JS bundle missing"
  } else if (spec.id === "backend-fastapi-postgres") {
    if (!outputPaths.some((path) => path.endsWith(".pyc"))) return "FastAPI bytecode missing"
    if (!(await contains(projectRoot, "app/main.py", 'get("/healthz")')))
      return "FastAPI health surface missing"
  } else if (spec.id === "backend-nestjs-postgres") {
    if (!(await contains(projectRoot, "dist/main.js", "bootstrap")))
      return "Nest bootstrap output missing"
    if (!(await contains(projectRoot, "dist/app.js", "healthz")))
      return "Nest health output missing"
  } else if (spec.id === "backend-go-postgres") {
    const binary = artifacts.find(
      (artifact) => artifact.path.endsWith("/server") || artifact.path === "server",
    )
    if (binary === undefined || binary.size < 1) return "Go server binary missing"
  } else if (spec.platform === "ios") {
    if (!outputPaths.some((path) => path.endsWith(".app/Info.plist")))
      return "iOS app metadata missing"
    if (!outputPaths.some((path) => path.endsWith(".app/HarnessIOS")))
      return "iOS app binary missing"
  } else if (spec.platform === "android") {
    const extension = stage === "package" ? ".aab" : ".apk"
    const bundle = artifacts.find((artifact) => artifact.path.endsWith(extension))
    if (bundle === undefined) return `Android ${extension} missing`
    const contents = await readable(projectRoot, bundle.path)
    if (contents?.subarray(0, 2).toString("ascii") !== "PK")
      return `Android ${extension} is not an archive`
  }
  return undefined
}

export async function accessibilityAudit(
  projectRoot: string,
  spec: OfficialAdapterSpec,
): Promise<{ readonly checks: number; readonly rules: readonly string[] }> {
  if (spec.platform === "backend") return { checks: 0, rules: [] }
  const rules: string[] = []
  if (spec.platform === "web") {
    const sources = spec.artifacts.filter((item) => /\.(?:astro|html|tsx)$/.test(item.path))
    const current = await Promise.all(sources.map((item) => readable(projectRoot, item.path)))
    const text = current.map((item) => item?.toString("utf8") ?? "").join("\n")
    if (/lang=["'](?:en|ko)["']/.test(text)) rules.push("document-language")
    if (/<main\b/.test(text)) rules.push("main-landmark")
    if (spec.id !== "web-vite-react-pwa" || /name=["']viewport["']/.test(text))
      rules.push("responsive-viewport")
  } else if (spec.platform === "ios") {
    if (await contains(projectRoot, "HarnessIOS/LaunchView.swift", ".accessibility"))
      rules.push("swiftui-semantics")
  } else if (spec.platform === "android") {
    if (
      await contains(
        projectRoot,
        "app/src/androidTest/java/com/example/harness/MainActivityTest.kt",
        "assertIsDisplayed",
      )
    )
      rules.push("compose-semantics-test")
  }
  return { checks: rules.length, rules }
}
