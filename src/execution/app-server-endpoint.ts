import { lstat } from "node:fs/promises"
import { isAbsolute } from "node:path"

export async function serverArguments(socket: string | undefined): Promise<string[]> {
  if (socket === undefined) return ["app-server"]
  if (!isAbsolute(socket) || socket.includes("\0"))
    throw new Error("configured app-server socket must be absolute")
  const state = await lstat(socket)
  if (!state.isSocket() || state.isSymbolicLink())
    throw new Error("configured app-server endpoint must be a local socket")
  return ["app-server", "proxy", "--sock", socket]
}
