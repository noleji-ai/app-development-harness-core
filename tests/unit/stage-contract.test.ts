import assert from "node:assert/strict"
import test from "node:test"

import { parseCodexStageOutput } from "../../src/execution/stage-contract"

const expected = {
  runId: "run-contract",
  stage: "implementation" as const,
  inputHash: "a".repeat(64),
}

function completed() {
  return {
    schemaVersion: 1,
    ...expected,
    status: "completed",
    summary: "Implemented",
    evidence: [{ id: "artifact", path: "src/app.ts", description: "implementation" }],
    decisionIds: [],
    missingCapabilities: [],
    error: "",
  }
}

test("Codex stage result accepts only correlated non-contradictory completion", () => {
  assert.equal(parseCodexStageOutput(completed(), expected).status, "completed")
  assert.throws(
    () => parseCodexStageOutput({ ...completed(), missingCapabilities: ["toolchain"] }, expected),
    /contradictory/,
  )
  assert.throws(
    () => parseCodexStageOutput({ ...completed(), inputHash: "b".repeat(64) }, expected),
    /stale or mismatched/,
  )
  assert.throws(() => parseCodexStageOutput({ ...completed(), unexpected: true }, expected))
})

test("Codex stage result rejects model-authored release checks", () => {
  assert.throws(
    () =>
      parseCodexStageOutput(
        {
          ...completed(),
          checks: [{ id: "build", required: true, status: "passed", evidenceIds: ["artifact"] }],
        },
        expected,
      ),
    /unrecognized|invalid/i,
  )
})

test("Codex stage result rejects trusted Harness state as model evidence", () => {
  assert.throws(
    () =>
      parseCodexStageOutput(
        {
          ...completed(),
          evidence: [
            {
              id: "artifact",
              path: ".app-harness/evidence/request-analysis.json",
              description: "request analysis",
            },
          ],
        },
        expected,
      ),
    /invalid/i,
  )
})
