---
name: app-harness
description: Run the App Harness decision-led app delivery workflow. Use when the user explicitly invokes `$app-harness init|run|resume|status|verify|dashboard|doctor|upgrade`, or when a clear greenfield or major end-to-end app build needs PRD and design gates, dynamic technology recommendations, resumable implementation, QA evidence, and deploy-ready packaging. Do not use for questions, reviews, analysis, tiny fixes, or narrow bug repairs.
---

# App Harness

Use the bundled deterministic CLI for state, decisions, evidence, and resumability. Use Codex capabilities for research, design, implementation, and QA. Never claim the CLI itself generated product work.

## Command surface

Resolve the plugin root from this skill directory, then run:

```sh
node "${PLUGIN_ROOT}/dist/cli.js" <command> --project "<project-root>"
```

Support exactly: `init`, `run`, `resume`, `status`, `verify`, `dashboard`, `doctor`, and `upgrade`. Pass `--open` only to `dashboard`.

Start `run` with exactly one of `--request <text>` or `--request-file <contained-path>`. The file
form accepts bounded UTF-8 `.md`, `.txt`, or strict JSON input and is the preferred runner
interface for substantial product briefs.

## Workflow

1. Read the target project's instructions and inspect existing code before initialization.
2. Choose `create` for a new empty target, `extend` for an existing clean Git project, and `resume` only for existing App Harness state.
3. Initialize with the chosen mode. Fail closed on dirty worktrees, collisions, unsafe paths, symlinks, or unsupported capabilities.
4. Build the PRD from the user's request: user, problem, outcome, platforms, scope, constraints, and non-functional requirements. Record the artifact and start the run.
5. Stop at Gate 1 only when the PRD/scope decision is pending. Report the dashboard path and blocking-decision count in one short sentence.
6. After approval, create 2-5 genuinely distinct design directions. Backend-only products vary API experience, operational experience, and integration strategy. Stop at Gate 2 for one direction; do not mix candidates by default.
7. Score supported technology candidates using the locked 30/20/15/15/10/5/5 weights. Speak in product trade-offs, not framework trivia. Preserve an existing stack unless a migration is explicitly approved.
8. Implement only requested platforms through the selected adapter. Treat missing SDKs and simulators as `blocked` or `unverified`, never as success.
9. Run build, test, real-surface QA, accessibility, security, and release-bundle checks. Required failures, missing evidence, unverified checks, and waivers all prevent release readiness.
10. Package provider-neutral deploy-ready artifacts. Never deploy, use credentials, change DNS, or submit to an app store without a separate explicit request.

## Decision policy

- Persist every automatic and user decision in `decisions.jsonl`.
- Expose at most three blocking decisions per stage; bundle related product trade-offs.
- Auto-select only reversible decisions whose first-place score leads by at least 10 points.
- Require dashboard approval for close scores, irreversible choices, high external cost, privacy/retention/payment/regulation policy, migrations, or mandatory-verification waivers.
- When a dashboard decision changes, resume from the invalidated checkpoint rather than restarting the run.

## Dashboard policy

- Bind only to `127.0.0.1`; keep the random token memory-only and in the URL fragment.
- Treat the HTML as a view. The append-only ledger remains authoritative.
- Generate `snapshot.html` as scriptless and read-only.
- Do not mention the dashboard in conversation unless a blocking decision exists or the user explicitly asks for it.

## Completion report

Report the active run, completed stages, decisions still blocking, verification evidence, release-readiness result, changed project files, and remaining risks. A missing platform toolchain is a blocker, not a caveat hidden after a success claim.
