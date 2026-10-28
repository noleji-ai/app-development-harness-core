import { withBoundStateLock } from "./bound-state-directory"

const queues = new Map<string, Promise<void>>()

export class FileLockBusyError extends Error {
  override readonly name = "FileLockBusyError"
}

export class UnsafeFileLockError extends Error {
  override readonly name = "UnsafeFileLockError"
}

export class FileLockRecoveryRequiredError extends Error {
  override readonly name = "FileLockRecoveryRequiredError"
}

export async function withFileLock<T>(
  projectRoot: string,
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve()
  const gate = Promise.withResolvers<void>()
  const tail = previous.then(() => gate.promise)
  queues.set(path, tail)
  await previous
  try {
    return await withBoundStateLock(projectRoot, path, operation)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (Reflect.get(error, "code") === "ELOCKBUSY") {
        throw new FileLockBusyError(`lock is active: ${path}`)
      }
      if (Reflect.get(error, "code") === "EHARNESSUNSAFE") {
        throw new UnsafeFileLockError(`unsafe lock path: ${path}`)
      }
      if (Reflect.get(error, "code") === "ELOCKRECOVERY") {
        throw new FileLockRecoveryRequiredError(
          `legacy lock recovery required: ${path}; run app-harness doctor`,
        )
      }
    }
    throw error
  } finally {
    gate.resolve()
    if (queues.get(path) === tail) queues.delete(path)
  }
}
