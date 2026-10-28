import assert from "node:assert/strict"
import test from "node:test"
import { resolveModelPolicy } from "../../src/execution/model-policy"
import { parseUsageEvents } from "../../src/execution/model-usage"

test("stage routing preserves final judgment and bounds ordinary implementation", () => {
  assert.equal(resolveModelPolicy("implementation").model, "gpt-5.6-terra")
  assert.equal(resolveModelPolicy("implementation").effort, "medium")
  assert.equal(resolveModelPolicy("implementation", "complex").model, "gpt-5.6-sol")
  assert.equal(resolveModelPolicy("deploy-ready").model, "gpt-5.6-sol")
  assert.equal(resolveModelPolicy("deploy-ready").effort, "high")
  assert.equal(resolveModelPolicy("research-prd").profile, "app-dev-plan")
})

test("usage preserves missing telemetry as unknown and counts cached tokens separately", () => {
  assert.equal(parseUsageEvents("").tokens, null)
  const usage = parseUsageEvents(
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 25,
      },
    }),
  )
  assert.deepEqual(usage.tokens, { input: 100, cachedInput: 40, output: 25 })
  assert.equal(usage.reportedModel, null)
})

test("usage ignores model-authored text and rejects invalid counters", () => {
  assert.equal(
    parseUsageEvents(
      JSON.stringify({
        type: "item.completed",
        item: {
          text: '{"input_tokens":0,"output_tokens":0}',
        },
      }),
    ).tokens,
    null,
  )
  assert.equal(
    parseUsageEvents(
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: -1,
          cached_input_tokens: 0,
          output_tokens: 1,
        },
      }),
    ).tokens,
    null,
  )
})

test("app-server usage is thread-correlated and counts its own tool protocol", () => {
  const transcript = [
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "ours",
        tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 30, outputTokens: 20 } },
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "other",
        tokenUsage: { total: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 400 } },
      },
    },
    { method: "item/completed", params: { threadId: "ours", item: { type: "commandExecution" } } },
    { method: "item/completed", params: { threadId: "other", item: { type: "commandExecution" } } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n")
  assert.deepEqual(parseUsageEvents(transcript, "ours"), {
    reportedModel: null,
    toolCalls: 1,
    tokens: { input: 100, cachedInput: 30, output: 20 },
  })
})
