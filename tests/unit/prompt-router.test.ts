import assert from "node:assert/strict"
import test from "node:test"

import { routeUserPrompt } from "../../src/hooks/prompt-router.js"

test("routes clear greenfield app builds as advisory context", () => {
  const route = routeUserPrompt("Build a new iOS and Android marketplace app from scratch")
  assert.equal(route.matched, true)
  assert.match(route.advisory ?? "", /\$app-harness init/)
})

test("routes explicit large rebuilds", () => {
  assert.equal(routeUserPrompt("기존 서비스를 전면 재구축해줘").matched, true)
})

for (const prompt of [
  "Can you explain how this function works?",
  "Review this pull request",
  "Fix the typo in the login button",
  "이 코드가 왜 이렇게 동작해?",
]) {
  test(`does not activate for: ${prompt}`, () => {
    assert.deepEqual(routeUserPrompt(prompt), { matched: false })
  })
}
