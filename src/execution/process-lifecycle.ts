import type { ChildProcess } from "node:child_process"

export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  if (process.platform === "win32") {
    child.kill(signal)
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return
    throw error
  }
}

export async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return
  const closed =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("close", () => resolve()))
  signalProcessGroup(child, "SIGTERM")
  const force = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 500)
  try {
    await closed
  } finally {
    clearTimeout(force)
    signalProcessGroup(child, "SIGKILL")
  }
}
