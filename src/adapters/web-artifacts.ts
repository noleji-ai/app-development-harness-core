type WebPackageProfile = {
  readonly build: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly development: string
  readonly name: string
  readonly production: string
}

export function webPackage(profile: WebPackageProfile): string {
  return `${JSON.stringify(
    {
      name: profile.name,
      private: true,
      scripts: {
        build: profile.build,
        dev: profile.development,
        start: profile.production,
        test: "bun test tests/surface.test.ts",
        "qa:surface": "bun tests/http-qa.ts",
      },
      dependencies: profile.dependencies,
      devDependencies: { typescript: "6.0.2" },
    },
    null,
    2,
  )}\n`
}

export function httpQa(startArgs: readonly string[], marker: string): string {
  return `const START_ARGS = ${JSON.stringify(startArgs)} as const
const EXPECTED_MARKER = ${JSON.stringify(marker)}
const port = 41_791
const child = Bun.spawn(["bun", "run", "start", "--", ...START_ARGS, String(port)], {
  env: { ...Bun.env, PORT: String(port) },
  stdout: "ignore",
  stderr: "ignore",
})

let verified = false
let failure: Error | undefined
try {
  for (let attempt = 0; attempt < 40 && !verified; attempt += 1) {
    await Bun.sleep(250)
    try {
      const response = await fetch(\`http://127.0.0.1:\${port}/\`, {
        signal: AbortSignal.timeout(1_000),
      })
      const body = await response.text()
      if (!response.ok) throw new Error(\`surface returned \${response.status}\`)
      if (!body.includes(EXPECTED_MARKER)) throw new Error("surface marker is missing")
      verified = true
    } catch (error) {
      if (!(error instanceof Error)) throw error
      failure = error
    }
  }
  if (!verified) throw new Error(\`HTTP surface QA failed: \${failure?.message ?? "timeout"}\`)
} finally {
  child.kill()
  await child.exited
}
`
}

export const SURFACE_TEST = `import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("customer surface contains a main landmark", async () => {
  const source = await readFile(process.env.SURFACE_FILE ?? "app/page.tsx", "utf8")
  expect(source).toContain("<main")
})
`
