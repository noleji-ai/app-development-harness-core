import { runBoundStateOperation } from "./bound-state-directory"

export async function atomicWriteStateFile(
  projectRoot: string,
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  await runBoundStateOperation(projectRoot, path, { kind: "atomic", contents })
}

export async function createStateFile(
  projectRoot: string,
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  await runBoundStateOperation(projectRoot, path, { kind: "create", contents })
}

export async function appendStateFile(
  projectRoot: string,
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  await runBoundStateOperation(projectRoot, path, { kind: "append", contents })
}
