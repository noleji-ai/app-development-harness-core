# Model execution policy — 2026-09-06

Harness owns model execution. A caller such as Noleji Launch must not run another Codex task after `run`, `resume`, `verify`, or `status`.

| Stage | Model | Effort | Profile |
| --- | --- | --- | --- |
| request-analysis | gpt-5.6-sol | medium | app-dev-plan |
| research-prd, design-candidates, technology-optimization | gpt-5.6-sol | high | app-dev-plan |
| implementation, standard | gpt-5.6-terra | medium | app-dev |
| implementation, complex | gpt-5.6-sol | medium | app-dev |
| verification, deploy-ready | gpt-5.6-sol | high | app-dev |

Use `APP_HARNESS_IMPLEMENTATION_TIER=complex` for difficult cross-module, concurrency or security-sensitive implementation. Unknown tiers fail validation. Status, artifact lookup and explicit trusted verification do not invoke a model. Gate decisions remain in the ledger. PBH's separate repair wrapper supplies Luna/low for bounded repetitive work.

Both transports receive explicit model/effort, a two-worker cap, a 180,000-token compaction threshold and standard service tier. Global Codex configuration is unchanged. Local `app-dev` and `app-dev-plan` profiles must exist. App-server confirms its model before turn submission and rejects reroute events. Only a pre-submission transport failure may fall back to exec with the same policy and remaining timeout. Cancellation, model-policy failure and uncertain submitted work are not replayed.

## Identity and evidence

`run --run-id ID` creates that identity. For resume/verify/status, a supplied run ID must equal the active run before mutation. `resume --decision-event-id HASH` requires a recorded decision-ledger event for that run; it does not manufacture approval.

`status --run-id ID --artifact-id ID` returns a hash-verified artifact endorsed by a current completed stage and its usage receipt. `sealed` distinguishes stage output from a fully verified run. Unknown or invalidated artifacts fail lookup.

`.app-harness/evidence/model-usage.jsonl` and exclusive `model-execution-*.json` receipts record run/stage/attempt/input, policy, final stage outcome, transport outcome, elapsed time and available native usage. Missing token/model reports remain null. External child-model usage cannot be inferred from absent telemetry; these records are not billing invoices.

Checkpoint v3 binds policy, source, artifacts and terminal receipt hash/content. Reconciliation detects overwritten or planted checkpoint/receipt files. Unix local transports terminate their process groups before reconciliation, and app-server completion waits for its local child to close. This is worker hygiene, not an isolation boundary against daemonized/external writers; a shared external app-server and Windows process supervision remain operator trust boundaries. Current checkpoints bind final stage/source hashes after trusted completion. Logs, dependency/build trees and generated artifact directories are excluded from source hashing; referenced artifacts are independently hashed. Old v2 checkpoints are not reused and may require a one-time rerun.

Validation: `bun run check`, `bun run build`, `bun run test`. The test script excludes archived release copies and allows 20 seconds for real-process integration fixtures. Coverage includes model mismatch/reroute, foreign-thread usage, stale run IDs, planted checkpoints, receipt correlation, final sealing and invalidated artifact lookup.
