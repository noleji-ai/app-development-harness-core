import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import { basename, dirname, relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline"

import { BOUND_STATE_WORKER_SOURCE } from "./bound-state-worker-source"
import { assertSafeStateDirectory, assertSafeStateFile } from "./safe-path"

type OperationKind = "append" | "atomic" | "create" | "lock" | "mkdir" | "unlock"
type Pending = { readonly resolve: () => void; readonly reject: (error: Error) => void }
type WorkerIdentity = { readonly dev: string; readonly ino: string; readonly canonical: string }
type WorkerMessage = {
  readonly kind?: unknown
  readonly id?: unknown
  readonly dev?: unknown
  readonly ino?: unknown
  readonly canonical?: unknown
  readonly code?: unknown
  readonly message?: unknown
}

const workers = new Map<string, Promise<BoundStateWorker>>()
const idleClosures = new Map<string, ReturnType<typeof setTimeout>>()
const WORKER_IDLE_MS = 1_000

export class UnsupportedStateBindingError extends Error {
  override readonly name = "UnsupportedStateBindingError"
}

class BoundStateOperationError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

function isContained(root: string, target: string): boolean {
  const route = relative(root, target)
  return route === "" || (route !== ".." && !route.startsWith(`..${sep}`))
}

function setReferenced(child: ChildProcessWithoutNullStreams, referenced: boolean): void {
  const method = referenced ? "ref" : "unref"
  child[method]()
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    const control = stream as typeof stream & { ref?: () => void; unref?: () => void }
    control[method]?.()
  }
}

class BoundStateWorker {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly ready: Promise<WorkerIdentity>
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private active = 0
  private exited = false
  private stderr = ""

  constructor(readonly directory: string) {
    this.child = spawn(process.execPath, ["-e", BOUND_STATE_WORKER_SOURCE], {
      cwd: directory,
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    const ready = Promise.withResolvers<WorkerIdentity>()
    this.ready = ready.promise
    const lines = createInterface({ input: this.child.stdout })
    lines.on("line", (line) => {
      const message = JSON.parse(line) as WorkerMessage
      if (message.kind === "ready") {
        ready.resolve({
          dev: String(message.dev),
          ino: String(message.ino),
          canonical: String(message.canonical),
        })
        return
      }
      const id = Number(message.id)
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      if (message.kind === "result") pending.resolve()
      else
        pending.reject(
          new BoundStateOperationError(
            String(message.message),
            typeof message.code === "string" ? message.code : undefined,
          ),
        )
    })
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_096)
    })
    this.child.once("error", (error) => ready.reject(error))
    this.child.once("exit", (exitCode) => {
      this.exited = true
      const error = new BoundStateOperationError(
        `bound state worker exited (${exitCode ?? "signal"})${this.stderr === "" ? "" : `: ${this.stderr}`}`,
      )
      ready.reject(error)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
  }

  async identity(): Promise<WorkerIdentity> {
    const identity = await this.ready
    if (this.active === 0) setReferenced(this.child, false)
    return identity
  }

  isExited(): boolean {
    return this.exited
  }

  isIdle(): boolean {
    return this.active === 0
  }

  async command(kind: OperationKind, name: string, contents?: string | Uint8Array): Promise<void> {
    if (this.exited) throw new BoundStateOperationError("bound state worker is unavailable")
    const id = this.nextId
    this.nextId += 1
    this.active += 1
    setReferenced(this.child, true)
    const result = new Promise<void>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.child.stdin.write(
      `${JSON.stringify({
        id,
        kind,
        name,
        ...(contents === undefined ? {} : { contents: Buffer.from(contents).toString("base64") }),
      })}\n`,
    )
    try {
      await result
    } finally {
      this.active -= 1
      if (this.active === 0) setReferenced(this.child, false)
    }
  }

  close(): void {
    this.child.kill()
    this.exited = true
  }
}

function cancelIdleClosure(directory: string): void {
  const closure = idleClosures.get(directory)
  if (closure === undefined) return
  clearTimeout(closure)
  idleClosures.delete(directory)
}

function scheduleIdleClosure(worker: BoundStateWorker): void {
  if (!worker.isIdle()) return
  cancelIdleClosure(worker.directory)
  const closure = setTimeout(() => {
    const current = workers.get(worker.directory)
    if (current !== undefined) {
      current.then((candidate) => {
        if (candidate === worker && candidate.isIdle()) {
          candidate.close()
          workers.delete(worker.directory)
        }
      })
    }
    idleClosures.delete(worker.directory)
  }, WORKER_IDLE_MS)
  closure.unref()
  idleClosures.set(worker.directory, closure)
}

async function startBoundWorker(projectRoot: string, directory: string): Promise<BoundStateWorker> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new UnsupportedStateBindingError(
      `race-safe state binding is unavailable on ${process.platform}`,
    )
  }
  await assertSafeStateDirectory(projectRoot, directory)
  const expected = await lstat(directory, { bigint: true })
  if (!expected.isDirectory() || expected.isSymbolicLink()) {
    throw new UnsupportedStateBindingError(`cannot bind unsafe state directory: ${directory}`)
  }
  const worker = new BoundStateWorker(directory)
  try {
    const identity = await worker.identity()
    const canonicalRoot = await realpath(resolve(projectRoot))
    if (
      identity.dev !== expected.dev.toString() ||
      identity.ino !== expected.ino.toString() ||
      !isContained(canonicalRoot, identity.canonical)
    ) {
      throw new UnsupportedStateBindingError(`state directory changed while binding: ${directory}`)
    }
    return worker
  } catch (error) {
    worker.close()
    throw error
  }
}

async function boundDirectoryWorker(
  projectRoot: string,
  directory: string,
): Promise<BoundStateWorker> {
  await assertSafeStateDirectory(projectRoot, directory)
  cancelIdleClosure(directory)
  let workerPromise = workers.get(directory)
  let existing = workerPromise === undefined ? undefined : await workerPromise
  if (existing?.isExited()) {
    workers.delete(directory)
    workerPromise = undefined
    existing = undefined
  }
  if (existing !== undefined) {
    const current = await lstat(directory, { bigint: true })
    const identity = await existing.identity()
    if (
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev.toString() === identity.dev &&
      current.ino.toString() === identity.ino
    ) {
      return existing
    }
    throw new UnsupportedStateBindingError(`state directory identity changed: ${directory}`)
  }
  const started = startBoundWorker(projectRoot, directory)
  workers.set(directory, started)
  try {
    return await started
  } catch (error) {
    if (workers.get(directory) === started) workers.delete(directory)
    throw error
  }
}

async function boundWorker(projectRoot: string, path: string): Promise<BoundStateWorker> {
  await assertSafeStateFile(projectRoot, path)
  return boundDirectoryWorker(projectRoot, dirname(path))
}

export async function runBoundStateOperation(
  projectRoot: string,
  path: string,
  operation: { readonly kind: OperationKind; readonly contents?: string | Uint8Array },
): Promise<void> {
  const worker = await boundWorker(projectRoot, path)
  try {
    await worker.command(operation.kind, basename(path), operation.contents)
  } finally {
    scheduleIdleClosure(worker)
  }
}

export async function createBoundStateDirectory(projectRoot: string, path: string): Promise<void> {
  const worker = await boundDirectoryWorker(projectRoot, dirname(path))
  try {
    await worker.command("mkdir", basename(path))
  } finally {
    scheduleIdleClosure(worker)
  }
}

export async function closeBoundStateWorkers(): Promise<void> {
  for (const closure of idleClosures.values()) clearTimeout(closure)
  idleClosures.clear()
  const active = [...workers.values()]
  workers.clear()
  await Promise.allSettled(active.map(async (worker) => (await worker).close()))
}

export async function withBoundStateLock<T>(
  projectRoot: string,
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  await assertSafeStateFile(projectRoot, path)
  const worker = await startBoundWorker(projectRoot, dirname(path))
  try {
    await worker.command("lock", basename(path))
    try {
      return await operation()
    } finally {
      await worker.command("unlock", basename(path))
    }
  } finally {
    worker.close()
  }
}
