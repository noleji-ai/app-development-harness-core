import { z } from "zod"

const Counter = z.number().int().nonnegative().safe()
const Tokens = z
  .object({
    input_tokens: Counter,
    cached_input_tokens: Counter,
    output_tokens: Counter,
  })
  .refine((value) => value.cached_input_tokens <= value.input_tokens)
const ExecUsage = z.object({ type: z.literal("turn.completed"), usage: Tokens })
const ServerUsage = z.object({
  method: z.literal("thread/tokenUsage/updated"),
  params: z.object({
    threadId: z.string(),
    tokenUsage: z.object({
      total: z.object({
        inputTokens: Counter,
        cachedInputTokens: Counter,
        outputTokens: Counter,
      }),
    }),
  }),
})
const ThreadModel = z.union([
  z.object({ type: z.literal("thread.started"), model: z.string().min(1).max(128) }),
  z.object({
    id: z.literal(2),
    result: z.object({ thread: z.object({ id: z.string() }), model: z.string().min(1).max(128) }),
  }),
])

export interface ModelUsage {
  readonly tokens: {
    readonly input: number
    readonly cachedInput: number
    readonly output: number
  } | null
  readonly reportedModel: string | null
  readonly toolCalls: number
}

export function parseUsageEvents(transcript: string, threadId?: string): ModelUsage {
  let tokens: ModelUsage["tokens"] = null
  let reportedModel: string | null = null
  let toolCalls = 0
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
    const exec = ExecUsage.safeParse(raw)
    if (exec.success && threadId === undefined) {
      const value = exec.data.usage
      tokens = {
        input: value.input_tokens,
        cachedInput: value.cached_input_tokens,
        output: value.output_tokens,
      }
    }
    const server = ServerUsage.safeParse(raw)
    if (server.success && threadId !== undefined && server.data.params.threadId === threadId) {
      const value = server.data.params.tokenUsage.total
      if (value.cachedInputTokens <= value.inputTokens)
        tokens = {
          input: value.inputTokens,
          cachedInput: value.cachedInputTokens,
          output: value.outputTokens,
        }
    }
    const model = ThreadModel.safeParse(raw)
    if (model.success) {
      if ("model" in model.data && threadId === undefined) reportedModel = model.data.model
      else if ("result" in model.data && model.data.result.thread.id === threadId)
        reportedModel = model.data.result.model
    }
    const tool = z
      .object({
        type: z.literal("item.completed"),
        item: z.object({
          type: z.enum(["command_execution", "mcp_tool_call", "web_search"]),
        }),
      })
      .safeParse(raw)
    if (tool.success && threadId === undefined) toolCalls++
    const serverTool = z
      .object({
        method: z.literal("item/completed"),
        params: z.object({
          threadId: z.string(),
          item: z.object({ type: z.enum(["commandExecution", "mcpToolCall", "webSearch"]) }),
        }),
      })
      .safeParse(raw)
    if (
      serverTool.success &&
      threadId !== undefined &&
      serverTool.data.params.threadId === threadId
    )
      toolCalls++
  }
  return { tokens, reportedModel, toolCalls }
}
