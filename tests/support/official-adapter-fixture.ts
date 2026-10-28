import { expect } from "bun:test"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AdapterContext, AppAdapter } from "../../src/adapters/contract"
import { ADAPTERS } from "../../src/adapters/registry"
import { createTempDirectoryTracker } from "./temp-directory"

const TOOLCHAINS = [
  "bun",
  "go",
  "python3",
  "xcodebuild",
  "gradle",
  "next",
  "astro",
  "vite",
  "tsc",
  "pg_dump",
  "pg_restore",
  "psql",
] as const
const TOOLCHAIN_OUTPUT: Readonly<Record<(typeof TOOLCHAINS)[number], string>> = {
  bun: "1.3.11",
  go: "go version go1.26.5 darwin/arm64",
  python3: "Python 3.14.6",
  xcodebuild: "Xcode 26.6",
  gradle: "Gradle 9.2.1",
  next: "Next.js v16.2.10",
  astro: "astro 7.0.7",
  vite: "vite/8.1.4",
  tsc: "Version 6.0.2",
  pg_dump: "pg_dump (PostgreSQL) 18.1",
  pg_restore: "pg_restore (PostgreSQL) 18.1",
  psql: "psql (PostgreSQL) 18.1",
}
const CREDENTIALED_DATABASE_URL =
  "postgresql://사용자:p%40ss%F0%9F%94%90@fixture.invalid/app_harness_disposable"
const DATABASE_SECRET_MARKERS = ["사용자", "p%40ss", "%F0%9F%94%90"] as const

type Toolchain = (typeof TOOLCHAINS)[number]

export type ToolchainFixtureOptions = {
  readonly failureArgs?: string
  readonly forgedProjectEvidenceOnly?: boolean
  readonly noEvidence?: boolean
  readonly outputs?: Readonly<Partial<Record<Toolchain, string>>>
}

export function createOfficialAdapterFixture() {
  const tracker = createTempDirectoryTracker()

  async function toolchainFixture(options: ToolchainFixtureOptions) {
    const path = await tracker.create(join(tmpdir(), "adapter-toolchains-"))
    const log = join(path, "calls.log")
    for (const executable of TOOLCHAINS) {
      if (options.forgedProjectEvidenceOnly === true && executable !== "bun") continue
      const target = join(path, executable)
      const source = `#!${process.execPath}
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
const command = args.join(" ")
fs.appendFileSync(process.env.HARNESS_ADAPTER_LOG, process.argv[1] + " " + command + "\\n")
if (command === ${JSON.stringify(options.failureArgs ?? "\0")}) process.exit(9)
console.log(${JSON.stringify(options.outputs?.[executable] ?? TOOLCHAIN_OUTPUT[executable])})
if (${JSON.stringify(options.forgedProjectEvidenceOnly === true)}) {
  if (command === "run build") {
    fs.mkdirSync(".next", { recursive: true })
    fs.writeFileSync(".next/BUILD_ID", "forged\\n")
  }
  if (command === "run test") console.log("HARNESS_TESTS_PASSED=99")
  if (command === "run qa:surface") {
    console.log("HARNESS_QA_PASSED=99")
    console.log("HARNESS_ACCESSIBILITY_PASSED=99")
  }
  process.exit(0)
}
if (${JSON.stringify(options.noEvidence === true)}) process.exit(0)
const write = (name, contents = "fixture-output\\n") => {
  fs.mkdirSync(path.dirname(name), { recursive: true })
  fs.writeFileSync(name, contents)
}
const serve = (body) => {
  const http = require("node:http")
  const portIndex = args.indexOf("--port")
  const port = portIndex < 0 ? Number(process.env.PORT || 3000) : Number(args[portIndex + 1])
  http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": body.startsWith("{") ? "application/json" : "text/html" })
    response.end(body)
  }).listen(port, "127.0.0.1")
}
const databaseState = ".fixture-postgresql-state"
if (${JSON.stringify(executable)} === "psql" && command.includes("SELECT COUNT(*)")) {
  console.log(fs.existsSync(databaseState) ? fs.readFileSync(databaseState, "utf8").trim() : "0")
}
if (${JSON.stringify(executable)} === "psql" && command.includes("INSERT INTO service_metadata")) {
  fs.writeFileSync(databaseState, "1\\n")
}
if (${JSON.stringify(executable)} === "pg_dump") {
  const output = args.find((argument) => argument.startsWith("--file="))?.slice(7)
  if (!output) process.exit(8)
  write(output, fs.existsSync(databaseState) ? fs.readFileSync(databaseState) : "0\\n")
}
if (${JSON.stringify(executable)} === "pg_restore") {
  fs.writeFileSync(databaseState, fs.readFileSync(args.at(-1)))
}
if (${JSON.stringify(executable)} === "next" && args[0] === "start") serve("<main>ready</main>")
if ((${JSON.stringify(executable)} === "astro" || ${JSON.stringify(executable)} === "vite") && args[0] === "preview") serve(${JSON.stringify(executable)} === "vite" ? '<div id="root"></div>' : "<main>ready</main>")
if (${JSON.stringify(executable)} === "bun" && command === "dist/main.js") serve('{"status":"ok"}')
if (${JSON.stringify(executable)} === "python3" && command.includes("-m fastapi run")) serve('{"status":"ok"}')
if (${JSON.stringify(executable)} === "next" && command === "build") {
  write(".next/BUILD_ID", "fixture-production-build\\n")
  write(".next/build-manifest.json", "{}\\n")
  write(".next/server/app/index.html", "<main>ready</main>\\n")
}
if (${JSON.stringify(executable)} === "astro" && command === "build") {
  write("dist/index.html", '<html lang="en"><main>ready</main></html>\\n')
}
if (${JSON.stringify(executable)} === "vite" && command === "build") {
  write("dist/index.html", '<html lang="en"><div id="root"></div></html>\\n')
  write("dist/assets/app.js", "document.querySelector('#root')\\n")
}
if (${JSON.stringify(executable)} === "tsc" && command === "-p tsconfig.json") {
  write("dist/main.js", "import { bootstrap } from './app.js'; bootstrap()\\n")
  write("dist/app.js", "export const healthz = '/healthz'\\n")
}
if (${JSON.stringify(executable)} === "go" && args[0] === "build") {
  const output = args.indexOf("-o")
  const binary = output < 0 ? "server" : args[output + 1]
  write(binary, "#!" + process.execPath + "\\nconst http=require('node:http');const port=Number((process.env.HTTP_ADDR||'127.0.0.1:8080').split(':').at(-1));http.createServer((_q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{\\"status\\":\\"ok\\"}')}).listen(port,'127.0.0.1')\\n")
  fs.chmodSync(binary, 0o700)
}
if (${JSON.stringify(executable)} === "python3" && command.includes("compileall")) {
  write((command.includes("tests") ? "tests" : "app") + "/__pycache__/fixture.pyc")
}
if (${JSON.stringify(executable)} === "xcodebuild" && command.includes("archive")) {
  write(".app-harness/releases/ios-swiftui/HarnessIOS.xcarchive/Products/Applications/HarnessIOS.app/Info.plist", "plist\\n")
  write(".app-harness/releases/ios-swiftui/HarnessIOS.xcarchive/Products/Applications/HarnessIOS.app/HarnessIOS", "binary\\n")
} else if (${JSON.stringify(executable)} === "xcodebuild" && !command.includes("-version")) {
  write(".app-harness/xcode-derived/Build/Products/Debug-iphonesimulator/HarnessIOS.app/Info.plist", "plist\\n")
  write(".app-harness/xcode-derived/Build/Products/Debug-iphonesimulator/HarnessIOS.app/HarnessIOS", "binary\\n")
}
if (${JSON.stringify(executable)} === "gradle" && !command.includes("--version")) {
  write(".gradle/fixture-state")
  if (command.includes("assembleDebug")) write("app/build/outputs/apk/debug/app-debug.apk", Buffer.from("PK\\x03\\x04fixture"))
  if (command.includes("bundleRelease")) write("app/build/outputs/bundle/release/app-release.aab", Buffer.from("PK\\x03\\x04fixture"))
}
const isTest = /test|unittest|connectedDebugAndroidTest/.test(command)
if (${JSON.stringify(executable)} === "bun" && isTest) console.log("3 pass\\n0 fail")
if (${JSON.stringify(executable)} === "python3" && command.includes("unittest")) console.log("Ran 3 tests in 0.01s\\n\\nOK")
if (${JSON.stringify(executable)} === "go" && args[0] === "test") console.log(JSON.stringify({ Time: new Date().toISOString(), Action: "pass", Package: "example.com/harness/service/cmd/server", Test: "TestHealthSurface", Elapsed: 0.01 }))
if (${JSON.stringify(executable)} === "xcodebuild" && command.endsWith(" test")) console.log("Executed 3 tests, with 0 failures (0 unexpected) in 0.1 seconds")
if (${JSON.stringify(executable)} === "gradle" && /testDebugUnitTest|connectedDebugAndroidTest/.test(command)) console.log("3 tests completed, 0 failed")
`
      await writeFile(target, source, { mode: 0o700 })
      await chmod(target, 0o700)
    }
    return { path, log }
  }

  async function fixtureFor(
    adapter: AppAdapter,
    options: ToolchainFixtureOptions = {},
  ): Promise<{ readonly context: AdapterContext; readonly log: string }> {
    const tools = await toolchainFixture(options)
    return {
      log: tools.log,
      context: {
        projectRoot: await tracker.create(join(tmpdir(), `adapter-${adapter.id}-`)),
        mode: "create",
        requestedCapabilities: adapter.capabilities,
        toolchainPath: tools.path,
        executionEnvironment: {
          HARNESS_ADAPTER_LOG: tools.log,
          APP_HARNESS_BACKUP_DATABASE_URL: CREDENTIALED_DATABASE_URL,
          APP_HARNESS_BACKUP_DATABASE_DISPOSABLE: "yes",
        },
      },
    }
  }

  async function commitFixture(projectRoot: string): Promise<void> {
    const commands = [
      ["init"],
      ["config", "user.email", "fixture@example.test"],
      ["config", "user.name", "Fixture"],
      ["add", "."],
      ["commit", "-m", "fixture"],
    ] as const
    for (const args of commands) {
      const process = Bun.spawn(["/usr/bin/git", "-C", projectRoot, ...args], {
        stdout: "ignore",
        stderr: "ignore",
      })
      expect(await process.exited).toBe(0)
    }
  }

  async function readProjectFiles(projectRoot: string): Promise<string> {
    const contents: string[] = []
    const glob = new Bun.Glob("**/*")
    for await (const path of glob.scan({ cwd: projectRoot, dot: true, onlyFiles: true })) {
      contents.push(await readFile(join(projectRoot, path), "utf8"))
    }
    return contents.join("\n")
  }

  return {
    cleanup: tracker.cleanup,
    commitFixture,
    databaseSecretMarkers: DATABASE_SECRET_MARKERS,
    fixtureFor,
    official: ADAPTERS.filter((adapter) => adapter.platform !== "macos"),
    readProjectFiles,
    trackedTempDirectory: tracker.create,
  }
}
