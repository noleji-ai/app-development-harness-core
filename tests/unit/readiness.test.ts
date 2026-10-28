import assert from "node:assert/strict"
import test from "node:test"

import { assessReadiness } from "../../src/release/readiness.js"

test("release ready requires every required check to pass with evidence", () => {
  const result = assessReadiness([
    { id: "build", required: true, status: "passed", evidenceIds: ["ev-1"] },
    { id: "security", required: true, status: "passed", evidenceIds: ["ev-2"] },
  ])
  assert.equal(result.ready, true)
  assert.deepEqual(result.blockers, [])
})

for (const status of ["failed", "blocked", "unverified", "waived"] as const) {
  test(`${status} required check prevents release readiness`, () => {
    const result = assessReadiness([
      { id: "build", required: true, status: "passed", evidenceIds: ["ev-1"] },
      { id: "qa", required: true, status, evidenceIds: ["ev-2"] },
    ])
    assert.equal(result.ready, false)
    assert.equal(result.blockers[0]?.checkId, "qa")
  })
}

test("missing evidence prevents release readiness", () => {
  const result = assessReadiness([
    { id: "security", required: true, status: "passed", evidenceIds: [] },
  ])
  assert.equal(result.ready, false)
  assert.equal(result.blockers[0]?.reason, "missing-evidence")
})

test("duplicate check identifiers are rejected instead of overwriting a failure", () => {
  assert.throws(
    () =>
      assessReadiness([
        { id: "security", required: true, status: "failed", evidenceIds: ["failure"] },
        { id: "security", required: true, status: "passed", evidenceIds: ["pass"] },
      ]),
    /duplicate/i,
  )
})

test("blank evidence identifiers are rejected as malformed", () => {
  assert.throws(
    () =>
      assessReadiness([{ id: "security", required: true, status: "passed", evidenceIds: ["   "] }]),
    /evidence|invalid/i,
  )
})
