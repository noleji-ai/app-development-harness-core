# Reproduce the checked source baseline

On 2026-10-28, the maintainer ran these checks on macOS with Bun 1.3.11, Node.js 26.7.0 and Python 3.14.5. Dependencies were installed from the lock file with lifecycle scripts disabled. This is a local maintainer observation.

| Check | Observed result |
| --- | --- |
| `bun run check` | Type checking and configured source checks passed |
| `bun test ./tests/ --timeout 20000` | 230 tests passed |
| `bun run build` | Three Node bundles built successfully |
| `node dist/cli.js --help` | Exited successfully |
| `init`, `status`, `doctor` on a new temporary directory | All exited successfully; status reported initialized and no active run |
| Python maintenance-evidence unit tests | 12 tests passed |

See the root README for commands. The checked path made no model calls and incurred no provider usage charges. Included bundles contain third-party notices and exclude personal build-location comments.

## Understand the remaining verification work

These results do not establish live model execution, safety certification, deployment readiness, other operating systems, independent users, educational outcomes, API savings or grant selection. The source includes a dashboard, but this baseline adds no new rendered-screen verification. Report reproducible failures with the exact revision and environment.
