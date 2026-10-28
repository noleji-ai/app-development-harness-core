import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { AdapterContext, AdapterResult, AppAdapter } from "../../src/adapters/contract"
import { trustedDigest } from "../../src/execution/trusted-adapter-evidence"

export type TrustedOperation = "build" | "test" | "manualQa" | "packageDeployReady"
export type OperationCounts = Record<TrustedOperation, number>

function emptyCounts(): OperationCounts {
  return { build: 0, test: 0, manualQa: 0, packageDeployReady: 0 }
}

async function ensureNextSurface(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, "app"), { recursive: true })
  await mkdir(join(projectRoot, "tests"), { recursive: true })
  await mkdir(join(projectRoot, ".next", "server", "app"), { recursive: true })
  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ dependencies: { next: "16.2.10" } })}\n`,
  )
  await writeFile(
    join(projectRoot, "app", "layout.tsx"),
    'export default function RootLayout() { return <html lang="en"><body /></html> }\n',
  )
  await writeFile(
    join(projectRoot, "app", "page.tsx"),
    "export default function Home() { return <main>ready</main> }\n",
  )
  await writeFile(join(projectRoot, "tests", "surface.test.ts"), "import '../app/page'\n")
  await writeFile(join(projectRoot, ".next", "BUILD_ID"), "fixture\n")
  await writeFile(join(projectRoot, ".next", "build-manifest.json"), "{}\n")
  await writeFile(join(projectRoot, ".next", "server", "app", "index.html"), "<main>ready</main>\n")
}

export async function createCountingToolchain(projectRoot: string): Promise<string> {
  const path = join(projectRoot, ".counting-toolchain")
  await mkdir(path, { recursive: true })
  const next = join(path, "next")
  await writeFile(next, `#!${process.execPath}\nconsole.log("Next.js v16.2.10")\n`, {
    mode: 0o700,
  })
  await chmod(next, 0o700)
  return path
}

async function result(
  context: AdapterContext,
  adapterId: string,
  operation: TrustedOperation,
  counts: OperationCounts,
): Promise<AdapterResult> {
  counts[operation] += 1
  const command = { executable: "trusted-fixture", args: [operation] }
  const base = {
    status: "passed" as const,
    summary: `${operation} passed`,
    commands: [command],
    commandReceipts: [
      {
        ...command,
        outcome: "passed" as const,
        exitCode: 0,
        stdoutHash: trustedDigest(`${operation}:${counts[operation]}`),
      },
    ],
  }
  if (operation === "build") {
    await ensureNextSurface(context.projectRoot)
    return {
      ...base,
      outputArtifacts: [
        { path: ".next/BUILD_ID", sha256: trustedDigest("fixture\n"), size: 8 },
        { path: ".next/build-manifest.json", sha256: trustedDigest("{}\n"), size: 3 },
      ],
    }
  }
  if (operation === "test") return { ...base, executedChecks: 3 }
  if (operation === "manualQa") return { ...base, executedChecks: 2, accessibilityChecks: 1 }

  await ensureNextSurface(context.projectRoot)
  const artifactPath = join(context.projectRoot, ".app-harness", "releases", adapterId)
  const contents = `${JSON.stringify({
    adapterId,
    providerNeutral: true,
    signed: false,
    artifact: "fixture",
  })}\n`
  await mkdir(artifactPath, { recursive: true })
  await writeFile(join(artifactPath, "manifest.json"), contents)
  return {
    ...base,
    outputArtifacts: [
      {
        path: `.app-harness/releases/${adapterId}/manifest.json`,
        sha256: trustedDigest(contents),
        size: Buffer.byteLength(contents),
      },
    ],
  }
}

export function createCountingAdapter(adapterId = "web-next"): {
  readonly adapter: AppAdapter
  readonly counts: OperationCounts
} {
  const counts = emptyCounts()
  const skipped = async (): Promise<AdapterResult> => ({
    status: "passed",
    summary: "not used",
    commands: [{ executable: "trusted-fixture", args: ["unused"] }],
    commandReceipts: [
      {
        executable: "trusted-fixture",
        args: ["unused"],
        outcome: "passed",
        exitCode: 0,
        stdoutHash: trustedDigest("unused"),
      },
    ],
  })
  return {
    counts,
    adapter: {
      id: adapterId,
      platform: "web",
      version: "1.0.0",
      capabilities: ["build", "test", "manual-qa", "deploy-ready"],
      detect: skipped,
      plan: skipped,
      scaffold: skipped,
      build: (context) => result(context, adapterId, "build", counts),
      test: (context) => result(context, adapterId, "test", counts),
      manualQa: (context) => result(context, adapterId, "manualQa", counts),
      packageDeployReady: (context) => result(context, adapterId, "packageDeployReady", counts),
    },
  }
}
