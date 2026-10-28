import assert from "node:assert/strict"
import test from "node:test"

import { redactCodexDiagnostic } from "../../src/execution/codex-exec"

test("Codex diagnostics redact bearer and API secret values", () => {
  const diagnostic = redactCodexDiagnostic(
    "api_key=secret-value token: token-value Authorization: Bearer abc.def.ghi sk-secretvalue",
  )

  assert.doesNotMatch(diagnostic, /secret-value|token-value|abc\.def\.ghi|sk-secretvalue/)
  assert.match(diagnostic, /\[REDACTED\]/)
})
