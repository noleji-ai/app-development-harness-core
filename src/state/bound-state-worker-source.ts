function runBoundStateWorker(): void {
  // allow: SIZE_OK — this security state machine is serialized with Function#toString into one
  // dependency-free, directory-bound worker process and cannot safely capture imported helpers.
  const getBuiltinModule = Reflect.get(process, "getBuiltinModule") as
    | ((identifier: string) => unknown)
    | undefined
  if (getBuiltinModule === undefined) throw new Error("built-in module loading is unavailable")
  const nodeFs = getBuiltinModule("node:fs") as typeof import("node:fs")
  const { constants, realpathSync } = nodeFs
  const fs = getBuiltinModule("node:fs/promises") as typeof import("node:fs/promises")
  const { randomUUID } = getBuiltinModule("node:crypto") as typeof import("node:crypto")

  type Request = {
    readonly id: number
    readonly kind: "append" | "atomic" | "create" | "lock" | "mkdir" | "unlock"
    readonly name: string
    readonly contents?: string
  }

  type HeldLock = {
    readonly name: string
    readonly claim: string
    readonly token: string
    readonly dev: string
    readonly ino: string
    readonly handle: import("node:fs/promises").FileHandle
  }

  type LockMetadata = {
    readonly pid: number
    readonly createdAt: string
    readonly token?: string
    readonly status?: "contending" | "held"
  }

  type FenceMetadata = {
    readonly kind: "app-harness-lock-fence"
    readonly protocolVersion: number
    readonly pid: 1
    readonly createdAt: string
    readonly token: string
  }

  type LockFile = {
    readonly path: string
    readonly state: import("node:fs").Stats
    readonly fenceMarker: boolean
    readonly metadata?: LockMetadata
    readonly fence?: FenceMetadata
  }

  const LOCK_PROTOCOL_VERSION = 2
  const LEGACY_FENCE_OWNER_PID = 1

  let buffer = ""
  let heldLock: HeldLock | undefined
  let queue = Promise.resolve()

  function code(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined
    const value = Reflect.get(error, "code")
    return typeof value === "string" ? value : undefined
  }

  function failure(message: string, errorCode = "EHARNESSUNSAFE"): Error {
    return Object.assign(new Error(message), { code: errorCode })
  }

  function send(value: object): void {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  }

  function safeName(name: string): void {
    if (
      name === "" ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      Buffer.byteLength(name) > 255
    ) {
      throw failure("unsafe state file name")
    }
  }

  async function readSafe(name: string): Promise<Buffer> {
    let handle: import("node:fs/promises").FileHandle
    try {
      handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (code(error) === "ENOENT") return Buffer.alloc(0)
      throw error
    }
    try {
      const state = await handle.stat()
      if (!state.isFile() || state.nlink !== 1) throw failure("unsafe state file")
      return await handle.readFile()
    } finally {
      await handle.close()
    }
  }

  async function writeTemporary(contents: Buffer): Promise<string> {
    const temporary = `.${randomUUID()}.tmp`
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
    const handle = await fs.open(temporary, flags, 0o600)
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await fs.unlink(temporary).catch(() => undefined)
      throw error
    }
    await handle.close()
    return temporary
  }

  async function atomic(name: string, contents: Buffer): Promise<void> {
    const temporary = await writeTemporary(contents)
    try {
      await fs.rename(temporary, name)
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async function create(name: string, contents: Buffer): Promise<void> {
    const temporary = await writeTemporary(contents)
    try {
      await fs.link(temporary, name)
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }

  function ownerIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (code(error) === "ESRCH") return false
      if (code(error) === "EPERM") return true
      throw error
    }
  }

  function parseLockMetadata(contents: string): LockMetadata | undefined {
    try {
      const parsed = JSON.parse(contents) as {
        readonly pid?: unknown
        readonly createdAt?: unknown
        readonly token?: unknown
        readonly status?: unknown
      }
      if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) return undefined
      if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)))
        return undefined
      if (parsed.token !== undefined && typeof parsed.token !== "string") return undefined
      if (parsed.status !== undefined && parsed.status !== "contending" && parsed.status !== "held")
        return undefined
      return {
        pid: Number(parsed.pid),
        createdAt: parsed.createdAt,
        ...(parsed.token === undefined ? {} : { token: parsed.token }),
        ...(parsed.status === undefined ? {} : { status: parsed.status }),
      }
    } catch {
      return undefined
    }
  }

  function parseFenceMetadata(contents: string): FenceMetadata | undefined {
    try {
      const parsed = JSON.parse(contents) as {
        readonly kind?: unknown
        readonly protocolVersion?: unknown
        readonly pid?: unknown
        readonly createdAt?: unknown
        readonly token?: unknown
      }
      if (parsed.kind !== "app-harness-lock-fence") return undefined
      if (!Number.isInteger(parsed.protocolVersion) || Number(parsed.protocolVersion) <= 0)
        return undefined
      if (parsed.pid !== LEGACY_FENCE_OWNER_PID) return undefined
      if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)))
        return undefined
      if (typeof parsed.token !== "string" || parsed.token === "") return undefined
      return {
        kind: parsed.kind,
        protocolVersion: Number(parsed.protocolVersion),
        pid: parsed.pid,
        createdAt: parsed.createdAt,
        token: parsed.token,
      }
    } catch {
      return undefined
    }
  }

  function hasFenceMarker(contents: string): boolean {
    try {
      const parsed = JSON.parse(contents) as { readonly kind?: unknown }
      return parsed.kind === "app-harness-lock-fence"
    } catch {
      return false
    }
  }

  async function inspectLockFile(path: string): Promise<LockFile | undefined> {
    let handle: import("node:fs/promises").FileHandle
    try {
      handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (code(error) === "ENOENT") return undefined
      throw error
    }
    try {
      const state = await handle.stat()
      if (!state.isFile() || state.nlink !== 1) throw failure("unsafe lock path")
      const contents = await handle.readFile("utf8")
      const metadata = parseLockMetadata(contents)
      const fence = parseFenceMetadata(contents)
      return {
        path,
        state,
        fenceMarker: hasFenceMarker(contents),
        ...(metadata === undefined ? {} : { metadata }),
        ...(fence === undefined ? {} : { fence }),
      }
    } finally {
      await handle.close()
    }
  }

  function rejectExistingBase(base: LockFile): never {
    if (base.fence !== undefined) {
      if (base.fence.protocolVersion === LOCK_PROTOCOL_VERSION) {
        throw failure("lock fence changed during acquisition")
      }
      throw failure("unsupported lock protocol fence; run app-harness doctor", "ELOCKPROTOCOL")
    }
    if (base.fenceMarker) {
      throw failure("invalid lock protocol fence; run app-harness doctor", "ELOCKRECOVERY")
    }
    if (base.metadata !== undefined && ownerIsAlive(base.metadata.pid)) {
      throw failure("legacy lock is active; retry after its owner exits", "ELOCKBUSY")
    }
    if (base.metadata === undefined && base.state.mtimeMs >= Date.now() - 300_000) {
      throw failure("legacy lock may still be initializing; retry", "ELOCKBUSY")
    }
    throw failure(
      "legacy lock recovery required; run app-harness doctor (automatic removal is unsafe)",
      "ELOCKRECOVERY",
    )
  }

  async function ensureLegacyFence(name: string): Promise<void> {
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW
    let handle: import("node:fs/promises").FileHandle
    try {
      handle = await fs.open(name, flags, 0o600)
    } catch (error) {
      if (code(error) !== "EEXIST") throw error
      const existing = await inspectLockFile(name)
      if (existing === undefined) throw failure("lock fence changed during acquisition")
      if (
        existing.fence !== undefined &&
        existing.fence.protocolVersion === LOCK_PROTOCOL_VERSION
      ) {
        return
      }
      return rejectExistingBase(existing)
    }
    try {
      const fence: FenceMetadata = {
        kind: "app-harness-lock-fence",
        protocolVersion: LOCK_PROTOCOL_VERSION,
        pid: LEGACY_FENCE_OWNER_PID,
        createdAt: new Date().toISOString(),
        token: randomUUID(),
      }
      const contents = Buffer.from(`${JSON.stringify(fence)}\n`)
      const written = await handle.write(contents, 0, contents.length, 0)
      if (written.bytesWritten !== contents.length) throw failure("incomplete lock fence write")
      await handle.sync()
      const state = await handle.stat()
      if (!state.isFile() || state.nlink !== 1) throw failure("unsafe created lock fence")
    } finally {
      await handle.close()
    }
  }

  function claimToken(name: string, candidate: string): string | undefined {
    const prefix = `.${name}.`
    const suffix = ".claim"
    if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) return undefined
    const token = candidate.slice(prefix.length, -suffix.length)
    return token === "" ? undefined : token
  }

  async function lockClaims(name: string): Promise<LockFile[]> {
    const claims: LockFile[] = []
    for (const candidate of await fs.readdir(".")) {
      const token = claimToken(name, candidate)
      if (token === undefined) continue
      const claim = await inspectLockFile(candidate)
      if (claim === undefined) continue
      const metadata = claim.metadata
      const validClaim =
        metadata?.token === token &&
        (metadata.status === "contending" || metadata.status === "held")
      if (!validClaim) {
        if (claim.state.mtimeMs >= Date.now() - 300_000) {
          throw failure("unsafe live lock claim")
        }
        continue
      }
      claims.push(claim)
    }
    return claims
  }

  function liveOnly(claims: LockFile[]): LockFile[] {
    return claims.filter(
      (claim) => claim.metadata !== undefined && ownerIsAlive(claim.metadata.pid),
    )
  }

  async function writeClaim(
    handle: import("node:fs/promises").FileHandle,
    metadata: Required<LockMetadata>,
  ): Promise<void> {
    const contents = Buffer.from(`${JSON.stringify(metadata)}\n`)
    await handle.truncate(0)
    const written = await handle.write(contents, 0, contents.length, 0)
    if (written.bytesWritten !== contents.length) throw failure("incomplete lock claim write")
    await handle.sync()
  }

  async function createClaim(name: string): Promise<HeldLock> {
    const token = randomUUID()
    const claim = `.${name}.${token}.claim`
    safeName(claim)
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW
    const handle = await fs.open(claim, flags, 0o600)
    try {
      await writeClaim(handle, {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        token,
        status: "contending",
      })
      const state = await handle.stat()
      if (!state.isFile() || state.nlink !== 1) throw failure("unsafe created lock claim")
      return {
        name,
        claim,
        token,
        dev: state.dev.toString(),
        ino: state.ino.toString(),
        handle,
      }
    } catch (error) {
      await handle.close().catch(() => undefined)
      await fs.unlink(claim).catch(() => undefined)
      throw error
    }
  }

  async function verifiedClaimHandle(
    lock: HeldLock,
    expectedStatus?: "contending" | "held",
  ): Promise<import("node:fs/promises").FileHandle> {
    const verifier = await fs.open(lock.claim, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const state = await verifier.stat()
      const metadata = parseLockMetadata(await verifier.readFile("utf8"))
      if (
        !state.isFile() ||
        state.nlink !== 1 ||
        state.dev.toString() !== lock.dev ||
        state.ino.toString() !== lock.ino ||
        metadata?.token !== lock.token ||
        metadata.pid !== process.pid ||
        (expectedStatus !== undefined && metadata.status !== expectedStatus)
      ) {
        throw failure("lock claim ownership changed")
      }
      return verifier
    } catch (error) {
      await verifier.close()
      throw error
    }
  }

  async function removeOwnedClaim(
    lock: HeldLock,
    expectedStatus?: "contending" | "held",
  ): Promise<void> {
    let verifier: import("node:fs/promises").FileHandle | undefined
    try {
      verifier = await verifiedClaimHandle(lock, expectedStatus)
      await fs.unlink(lock.claim)
    } finally {
      if (verifier !== undefined) await verifier.close()
      await lock.handle.close()
    }
  }

  async function removeStaleClaim(claim: LockFile): Promise<void> {
    const expected = claim.metadata
    if (expected?.token === undefined || expected.status === undefined) return
    let verifier: import("node:fs/promises").FileHandle
    try {
      verifier = await fs.open(claim.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (code(error) === "ENOENT") return
      throw error
    }
    try {
      const state = await verifier.stat()
      const current = parseLockMetadata(await verifier.readFile("utf8"))
      if (
        !state.isFile() ||
        state.nlink !== 1 ||
        state.dev !== claim.state.dev ||
        state.ino !== claim.state.ino ||
        current?.token !== expected.token ||
        current.pid !== expected.pid ||
        current.status !== expected.status
      ) {
        throw failure("stale lock claim identity changed")
      }
      if (!ownerIsAlive(current.pid)) await fs.unlink(claim.path)
    } finally {
      await verifier.close()
    }
  }

  async function acquireLock(name: string): Promise<void> {
    if (heldLock !== undefined) throw failure("worker already holds a lock")
    await ensureLegacyFence(name)
    const own = await createClaim(name)
    let acquired = false
    try {
      await ensureLegacyFence(name)
      const before = liveOnly(await lockClaims(name))
      if (before.some((claim) => claim.metadata?.status === "held")) {
        throw failure("lock is active", "ELOCKBUSY")
      }
      const winner = before
        .map((claim) => claim.metadata?.token)
        .filter((token): token is string => token !== undefined)
        .sort()[0]
      if (winner !== own.token) throw failure("lock is active", "ELOCKBUSY")
      await writeClaim(own.handle, {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        token: own.token,
        status: "held",
      })
      const verifier = await verifiedClaimHandle(own)
      await verifier.close()
      await ensureLegacyFence(name)
      const competingHolder = liveOnly(await lockClaims(name)).some(
        (claim) => claim.metadata?.status === "held" && claim.metadata.token !== own.token,
      )
      if (competingHolder) throw failure("competing lock holder detected", "ELOCKBUSY")
      for (const claim of await lockClaims(name)) {
        if (claim.metadata !== undefined && !ownerIsAlive(claim.metadata.pid)) {
          await removeStaleClaim(claim)
        }
      }
      heldLock = own
      acquired = true
    } finally {
      if (!acquired) await removeOwnedClaim(own)
    }
  }

  async function releaseLock(name: string): Promise<void> {
    if (heldLock === undefined || heldLock.name !== name) throw failure("lock is not held")
    const lock = heldLock
    await removeOwnedClaim(lock, "held")
    heldLock = undefined
  }

  async function dispatch(request: Request): Promise<void> {
    safeName(request.name)
    const contents = Buffer.from(request.contents ?? "", "base64")
    switch (request.kind) {
      case "atomic":
        await atomic(request.name, contents)
        break
      case "create":
        await create(request.name, contents)
        break
      case "append":
        await atomic(request.name, Buffer.concat([await readSafe(request.name), contents]))
        break
      case "lock":
        await acquireLock(request.name)
        break
      case "mkdir":
        await fs.mkdir(request.name, { mode: 0o700 })
        break
      case "unlock":
        await releaseLock(request.name)
        break
    }
    send({ kind: "result", id: request.id })
  }

  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const request = JSON.parse(line) as Request
      queue = queue
        .then(() => dispatch(request))
        .catch((error: unknown) => {
          send({
            kind: "error",
            id: request.id,
            code: code(error),
            message: error instanceof Error ? error.message : String(error),
          })
        })
      newline = buffer.indexOf("\n")
    }
  })
  const state = nodeFs.statSync(".", { bigint: true })
  send({
    kind: "ready",
    dev: state.dev.toString(),
    ino: state.ino.toString(),
    canonical: realpathSync("."),
  })
}

export const BOUND_STATE_WORKER_SOURCE = `(${runBoundStateWorker.toString()})()`
