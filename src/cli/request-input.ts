import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { extname, relative, resolve, sep } from "node:path"
import { z } from "zod"

import {
  DesignPolicyModeSchema,
  type DesignPolicySelection,
  DesignPolicySelectionSchema,
} from "../domain/design-policy"
import { option } from "./arguments"
import { CliUsageError } from "./contracts"

const MAX_REQUEST_BYTES = 256 * 1024
const REQUEST_EXTENSIONS = new Set([".json", ".md", ".txt"])
const JsonRequestSchema = z
  .object({
    request: z.string().trim().min(1),
    designPolicy: DesignPolicySelectionSchema.optional(),
  })
  .strict()

export type RunInput = {
  readonly request: string
  readonly designPolicy?: DesignPolicySelection
}

export class RequestInputError extends CliUsageError {
  override readonly name = "RequestInputError"
}

function isContained(root: string, target: string): boolean {
  const route = relative(root, target)
  return route === "" || (route !== ".." && !route.startsWith(`..${sep}`))
}

function parseText(contents: Buffer, extension: string): RunInput {
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents)
  } catch (error) {
    if (error instanceof TypeError) throw new RequestInputError("request file must be valid UTF-8")
    throw error
  }
  if (decoded.includes("\0")) throw new RequestInputError("request file contains a NUL byte")
  if (extension === ".json") {
    let parsed: unknown
    try {
      parsed = JSON.parse(decoded)
    } catch (error) {
      if (error instanceof SyntaxError) throw new RequestInputError("request JSON is malformed")
      throw error
    }
    try {
      const input = JsonRequestSchema.parse(parsed)
      return {
        request: input.request,
        ...(input.designPolicy === undefined ? {} : { designPolicy: input.designPolicy }),
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new RequestInputError('request JSON must contain only a non-empty "request" string')
      }
      throw error
    }
  }
  const request = decoded.trim()
  if (request === "") throw new RequestInputError("request file is empty")
  return { request }
}

async function readRequestFile(projectRoot: string, value: string): Promise<RunInput> {
  const lexicalRoot = resolve(projectRoot)
  const root = await realpath(lexicalRoot)
  const path = resolve(lexicalRoot, value)
  if (!isContained(lexicalRoot, path))
    throw new RequestInputError("request file escapes the project")
  const extension = extname(path).toLowerCase()
  if (!REQUEST_EXTENSIONS.has(extension)) {
    throw new RequestInputError("request file type must be .md, .txt, or .json")
  }
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new RequestInputError("request file must be a non-symlink regular file")
  }
  if (before.size === 0 || before.size > MAX_REQUEST_BYTES) {
    throw new RequestInputError("request file size must be between 1 byte and 256 KiB")
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const state = await handle.stat()
    const canonical = await realpath(path)
    if (
      !state.isFile() ||
      state.nlink !== 1 ||
      state.dev !== before.dev ||
      state.ino !== before.ino ||
      !isContained(root, canonical)
    ) {
      throw new RequestInputError("request file changed while opening")
    }
    return parseText(await handle.readFile(), extension)
  } finally {
    await handle.close()
  }
}

export function parseExplicitDesignPolicy(
  args: readonly string[],
): DesignPolicySelection | undefined {
  const rawMode = option(args, "--design-policy")
  const rawReason = option(args, "--design-policy-reason")
  if (rawMode === undefined) {
    if (rawReason !== undefined) {
      throw new RequestInputError("--design-policy-reason requires --design-policy")
    }
    return undefined
  }
  const parsed = DesignPolicyModeSchema.safeParse(rawMode)
  if (!parsed.success) {
    throw new RequestInputError("--design-policy must be required, delegated, or skip")
  }
  if (parsed.data === "skip" && (rawReason === undefined || rawReason.trim() === "")) {
    throw new RequestInputError("skip design policy requires a documented product reason")
  }
  const defaultReason =
    parsed.data === "required"
      ? "The product owner explicitly requires a design direction gate."
      : "The product owner delegates the API and operations design direction to the harness."
  return DesignPolicySelectionSchema.parse({
    mode: parsed.data,
    reason: rawReason?.trim() || defaultReason,
  })
}

export async function resolveRunInput(
  projectRoot: string,
  args: readonly string[],
): Promise<RunInput> {
  const hasInline = args.includes("--request")
  const hasFile = args.includes("--request-file")
  const sourceCount = args.filter(
    (value) => value === "--request" || value === "--request-file",
  ).length
  if (hasInline === hasFile || sourceCount !== 1) {
    throw new RequestInputError("run requires exactly one of --request or --request-file")
  }
  if (hasFile) {
    const path = option(args, "--request-file")
    if (path === undefined || path === "")
      throw new RequestInputError("--request-file needs a path")
    const input = await readRequestFile(projectRoot, path)
    const commandPolicy = parseExplicitDesignPolicy(args)
    if (input.designPolicy !== undefined && commandPolicy !== undefined) {
      throw new RequestInputError("design policy must be specified in only one input source")
    }
    return commandPolicy === undefined ? input : { ...input, designPolicy: commandPolicy }
  }
  const request = option(args, "--request")
  if (request === undefined || request.trim() === "") {
    throw new RequestInputError("--request needs non-empty text")
  }
  if (request.includes("\0") || Buffer.byteLength(request) > MAX_REQUEST_BYTES) {
    throw new RequestInputError("inline request exceeds the 256 KiB text limit")
  }
  const designPolicy = parseExplicitDesignPolicy(args)
  return {
    request: request.trim(),
    ...(designPolicy === undefined ? {} : { designPolicy }),
  }
}

export async function resolveRunRequest(
  projectRoot: string,
  args: readonly string[],
): Promise<string> {
  return (await resolveRunInput(projectRoot, args)).request
}
