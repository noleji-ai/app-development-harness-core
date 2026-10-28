import type { AdapterCommandReceipt, AdapterResult, AppAdapter } from "../adapters/contract"

export type TrustedAdapterOperation =
  | "build"
  | "test"
  | "manualQa"
  | "packageDeployReady"
  | "security"

export function validateTrustedResult(
  adapter: AppAdapter,
  operation: TrustedAdapterOperation,
  result: AdapterResult,
): readonly AdapterCommandReceipt[] {
  if (result.commands.length === 0) throw new Error("trusted adapter result lacks command receipts")
  const commandReceipts = result.commandReceipts
  if (commandReceipts === undefined || commandReceipts.length === 0) {
    throw new Error("trusted adapter result lacks command exit receipts")
  }
  if (result.commands.length !== commandReceipts.length) {
    throw new Error("trusted adapter command and exit receipt counts differ")
  }
  for (const command of result.commands) {
    if (
      command.executable.trim() === "" ||
      command.executable.includes("\0") ||
      command.args.some((arg) => arg.includes("\0"))
    ) {
      throw new Error("trusted adapter returned an invalid command receipt")
    }
  }
  for (const [index, receipt] of commandReceipts.entries()) {
    const command = result.commands[index]
    if (
      command === undefined ||
      command.executable !== receipt.executable ||
      command.args.length !== receipt.args.length ||
      command.args.some((arg, position) => arg !== receipt.args[position])
    ) {
      throw new Error("trusted adapter command receipt correlation mismatch")
    }
    if (!/^[a-f0-9]{64}$/.test(receipt.stdoutHash)) {
      throw new Error("trusted adapter returned an invalid stdout hash")
    }
    if (result.status === "passed" && (receipt.outcome !== "passed" || receipt.exitCode !== 0)) {
      throw new Error("trusted adapter pass contradicts a command exit receipt")
    }
  }
  if (result.status !== "passed") return commandReceipts
  if (
    (operation === "build" || operation === "packageDeployReady") &&
    (result.outputArtifacts === undefined || result.outputArtifacts.length === 0)
  ) {
    throw new Error(`trusted adapter ${operation} lacks concrete output artifacts`)
  }
  if (operation === "test" && (result.executedChecks ?? 0) < 1) {
    throw new Error("trusted adapter test lacks executed checks")
  }
  if (operation === "manualQa" && (result.executedChecks ?? 0) < 1) {
    throw new Error("trusted adapter manual QA lacks executed checks")
  }
  if (
    operation === "manualQa" &&
    adapter.platform !== "backend" &&
    (result.accessibilityChecks ?? 0) < 1
  ) {
    throw new Error("trusted adapter manual QA lacks accessibility checks")
  }
  for (const artifact of result.outputArtifacts ?? []) {
    if (
      artifact.path.trim() === "" ||
      artifact.path.includes("\0") ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 1
    ) {
      throw new Error("trusted adapter returned malformed output artifact evidence")
    }
  }
  return commandReceipts
}
