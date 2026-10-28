import { execFile } from "node:child_process"

export class WorkspaceDirtyError extends Error {
  readonly name = "WorkspaceDirtyError"
  constructor() {
    super("extend requires a clean Git workspace; dirty changes were detected")
  }
}

export class WorkspaceNotGitError extends Error {
  readonly name = "WorkspaceNotGitError"
  constructor() {
    super("extend requires an existing Git workspace")
  }
}

type GitResult = {
  readonly ok: boolean
  readonly stdout: string
}

function gitStatus(projectRoot: string): Promise<GitResult> {
  const { HOME = "" } = process.env
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/git",
      ["-C", projectRoot, "status", "--porcelain=v2", "-z", "--untracked-files=all"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 5000,
        windowsHide: true,
        env: { HOME, PATH: "/usr/bin:/bin" },
      },
      (error, stdout) => resolve({ ok: error === null, stdout }),
    )
  })
}

export async function assertCleanGitWorkspace(projectRoot: string): Promise<void> {
  const result = await gitStatus(projectRoot)
  if (!result.ok) throw new WorkspaceNotGitError()
  if (result.stdout !== "") throw new WorkspaceDirtyError()
}
