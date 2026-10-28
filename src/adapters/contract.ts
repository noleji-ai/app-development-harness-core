import type { Platform } from "../domain/technology"

export type AdapterStatus = "passed" | "blocked" | "unverified"

export type AdapterCommandReceipt = {
  readonly executable: string
  readonly args: readonly string[]
  readonly outcome: "passed" | "failed" | "missing" | "unsafe"
  readonly exitCode: number | null
  readonly stdoutHash: string
}

export type AdapterOutputArtifact = {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

export type AdapterContext = {
  readonly projectRoot: string
  readonly mode: "create" | "extend" | "resume"
  readonly requestedCapabilities: readonly string[]
  readonly toolchainPath?: string
  readonly executionEnvironment?: Readonly<Record<string, string>>
  readonly compatibilityLock?: {
    readonly adapterVersion: string
    readonly xcodeVersion: string
    readonly observedAt: string
  }
}

export type AdapterResult = {
  readonly status: AdapterStatus
  readonly summary: string
  readonly commands: readonly { readonly executable: string; readonly args: readonly string[] }[]
  readonly commandReceipts?: readonly AdapterCommandReceipt[]
  readonly outputArtifacts?: readonly AdapterOutputArtifact[]
  readonly executedChecks?: number
  readonly accessibilityChecks?: number
}

export interface AppAdapter {
  readonly id: string
  readonly platform: Platform
  readonly version: string
  readonly capabilities: readonly string[]
  detect(context: AdapterContext): Promise<AdapterResult>
  plan(context: AdapterContext): Promise<AdapterResult>
  scaffold(context: AdapterContext): Promise<AdapterResult>
  build(context: AdapterContext): Promise<AdapterResult>
  test(context: AdapterContext): Promise<AdapterResult>
  manualQa(context: AdapterContext): Promise<AdapterResult>
  packageDeployReady(context: AdapterContext): Promise<AdapterResult>
}
