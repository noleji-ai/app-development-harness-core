import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { verifyOutputArtifacts } from "../adapters/adapter-output"
import type { AdapterOutputArtifact } from "../adapters/contract"

export type AuditedFile = { readonly path: string; readonly sha256: string; readonly size: number }

const EXCLUDED = new Set([
  ".app-harness",
  ".build",
  ".git",
  ".gradle",
  ".next",
  "DerivedData",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
])
const MAX_AUDIT_FILES = 50_000
const TEXT_EXTENSIONS = new Set([
  "",
  ".env",
  ".go",
  ".html",
  ".js",
  ".json",
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".py",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
])

function contained(root: string, target: string): boolean {
  const route = relative(root, target)
  return route === "" || (route !== ".." && !route.startsWith(`..${sep}`))
}

async function walk(root: string, directory: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (EXCLUDED.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink())
      throw new Error(`audit encountered symbolic link: ${relative(root, path)}`)
    if (entry.isDirectory()) result.push(...(await walk(root, path)))
    else if (entry.isFile()) result.push(path)
    else throw new Error(`audit encountered unsupported file: ${relative(root, path)}`)
    if (result.length > MAX_AUDIT_FILES) {
      throw new Error(`audit file limit exceeded: ${MAX_AUDIT_FILES}`)
    }
  }
  return result
}

async function auditFile(root: string, path: string): Promise<AuditedFile> {
  const state = await lstat(path)
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    state.size > 100 * 1024 * 1024
  ) {
    throw new Error(`unsafe audited file: ${relative(root, path)}`)
  }
  if (!contained(root, await realpath(path))) throw new Error("audited file escaped project")
  const contents = await readFile(path)
  return {
    path: relative(root, path),
    sha256: createHash("sha256").update(contents).digest("hex"),
    size: contents.byteLength,
  }
}

function outputPath(root: string, artifact: AdapterOutputArtifact): string {
  if (isAbsolute(artifact.path) || artifact.path.includes("\0")) {
    throw new Error("unsafe adapter output path")
  }
  const path = resolve(root, artifact.path)
  if (!contained(root, path) || path === root) throw new Error("adapter output escaped project")
  return path
}

function containsCredential(text: string): boolean {
  return (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(text) ||
    /\b(?:sk|rk)-(?:live|prod)-[A-Za-z0-9_-]{16,}\b/.test(text)
  )
}

export async function securityAudit(
  projectRoot: string,
  outputArtifacts: readonly AdapterOutputArtifact[],
): Promise<{
  readonly filesScanned: number
  readonly fileHashes: readonly AuditedFile[]
  readonly outputArtifacts: readonly AdapterOutputArtifact[]
  readonly findings: readonly string[]
}> {
  const root = await realpath(resolve(projectRoot))
  if (outputArtifacts.length > 10) throw new Error("invalid adapter outputs")
  if (outputArtifacts.length > 0) await verifyOutputArtifacts(root, outputArtifacts)
  const packaged = new Set(outputArtifacts.map((artifact) => outputPath(root, artifact)))
  const candidates = [...new Set([...(await walk(root, root)), ...packaged])].sort()
  const findings: string[] = []
  const hashes: AuditedFile[] = []
  for (const path of candidates) {
    const audited = await auditFile(root, path)
    hashes.push(audited)
    const isPackaged = packaged.has(path)
    if (
      (!isPackaged && !TEXT_EXTENSIONS.has(extname(path).toLowerCase())) ||
      (!isPackaged && audited.size > 1024 * 1024)
    ) {
      continue
    }
    const text = await readFile(path, "utf8")
    if (containsCredential(text)) findings.push(audited.path)
  }
  return { filesScanned: hashes.length, fileHashes: hashes, outputArtifacts, findings }
}

export async function migrationAudit(projectRoot: string): Promise<{
  readonly applicable: boolean
  readonly migrations: readonly AuditedFile[]
}> {
  const root = await realpath(resolve(projectRoot))
  const candidates = (await walk(root, root)).filter((path) => {
    const segments = relative(root, path).split(sep)
    return (
      extname(path).toLowerCase() === ".sql" &&
      segments.some((segment) => /^migrations?$/i.test(segment))
    )
  })
  const migrations = await Promise.all(candidates.map((path) => auditFile(root, path)))
  return { applicable: migrations.length > 0, migrations }
}

export async function backupRestoreAudit(projectRoot: string): Promise<{
  readonly mode: "stateless"
  readonly filesScanned: number
  readonly indicators: readonly string[]
  readonly proofSha256: string
}> {
  const root = await realpath(resolve(projectRoot))
  const candidates = await walk(root, root)
  const indicators: string[] = []
  const proof = createHash("sha256")
  for (const path of candidates) {
    const audited = await auditFile(root, path)
    proof.update(`${audited.path}:${audited.sha256}\n`)
    const route = relative(root, path)
    if (
      extname(path).toLowerCase() === ".sql" &&
      route.split(sep).some((segment) => /^migrations?$/i.test(segment))
    ) {
      indicators.push(`migration:${route}`)
      continue
    }
    const textCandidate =
      TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || /^\.env(?:\.|$)/.test(route)
    if (!textCandidate || audited.size > 1024 * 1024) continue
    const text = await readFile(path, "utf8")
    if (/\b(?:DATABASE_URL|postgres(?:ql)?|sqlite|mysql|mongodb|redis)\b/i.test(text)) {
      indicators.push(`configuration:${route}`)
    }
  }
  if (indicators.length > 0) {
    throw new Error(
      `stateful project requires a declared backup restore contract: ${indicators[0]}`,
    )
  }
  return {
    mode: "stateless",
    filesScanned: candidates.length,
    indicators,
    proofSha256: proof.digest("hex"),
  }
}
