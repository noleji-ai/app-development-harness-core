#!/usr/bin/env node

import { spawn } from "node:child_process"
import { get } from "node:http"
import { createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"

const ConfigSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()),
    path: z.string().startsWith("/"),
    expected: z.string().min(1),
    format: z.enum(["bun", "go-json", "unittest"]),
    environment: z.record(z.string(), z.string()).optional(),
  })
  .strict()

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("surface QA could not allocate a port"))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

async function probe(port: number, path: string, expected: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const request = get({ host: "127.0.0.1", port, path, timeout: 500 }, (response) => {
      const body: Buffer[] = []
      response.on("data", (chunk: Buffer) => body.push(chunk))
      response.once("end", () => {
        resolveProbe(
          response.statusCode === 200 && Buffer.concat(body).toString("utf8").includes(expected),
        )
      })
    })
    request.once("timeout", () => request.destroy())
    request.once("error", () => resolveProbe(false))
  })
}

async function main(): Promise<void> {
  const config = ConfigSchema.parse(JSON.parse(process.argv[2] ?? ""))
  const port = await availablePort()
  const args = config.args.map((value) => value.replace("{port}", String(port)))
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...config.environment })) {
    if (typeof value === "string") environment[key] = value.replace("{port}", String(port))
  }
  const child = spawn(config.executable, args, {
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let diagnostics = ""
  child.stdout.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-4096)
  })
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-4096)
  })
  try {
    let passed = false
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`surface server exited early: ${diagnostics}`)
      if (await probe(port, config.path, config.expected)) {
        passed = true
        break
      }
      await delay(25)
    }
    if (!passed) throw new Error(`surface probe did not observe expected response: ${diagnostics}`)
    process.stdout.write(
      `APP_HARNESS_SURFACE_REPORT\t${JSON.stringify({ status: 200, expected: config.expected })}\n`,
    )
    if (config.format === "unittest") process.stdout.write("Ran 1 test in 0.01s\n\nOK\n")
    else if (config.format === "go-json")
      process.stdout.write(`${JSON.stringify({ Action: "pass", Test: "HarnessSurfaceProbe" })}\n`)
    else process.stdout.write("1 pass\n0 fail\n")
  } finally {
    child.kill("SIGTERM")
    const forced = setTimeout(() => child.kill("SIGKILL"), 250)
    forced.unref()
  }
}

// no-excuse-ok: catch — worker process boundary converts failures to stderr and a nonzero exit.
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
