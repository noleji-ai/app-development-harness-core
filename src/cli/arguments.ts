import { type RunMode, type WorkflowProfile, WorkflowProfileSchema } from "../domain/manifest.js"
import { CliUsageError } from "./contracts"

export function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

export function flag(args: readonly string[], name: string): boolean {
  return args.includes(name)
}

export function parseMode(value: string | undefined): RunMode {
  if (value === undefined) return "create"
  if (value === "create" || value === "extend" || value === "resume") return value
  throw new CliUsageError(`Invalid mode: ${value}`)
}

export function parseWorkflowProfile(value: string | undefined): WorkflowProfile | undefined {
  if (value === undefined) return undefined
  const parsed = WorkflowProfileSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new CliUsageError(`Invalid workflow profile: ${value}`)
}
