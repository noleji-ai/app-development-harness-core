# Official adapter contract

The harness core calls every platform through the same adapter interface: `detect`, `plan`,
`scaffold`, `build`, `test`, `manualQa`, and `packageDeployReady`. Adapter commands are always
executed as an executable plus an argument array. They never use a shell, install dependencies,
contact a deployment provider, sign an app, or submit a release.

## Supported profiles

| Adapter | Pinned profile | Scaffolded surface | Manual QA channel | Deploy-ready output |
| --- | --- | --- | --- | --- |
| `web-next` | Next.js 16.2.10 | App Router page and layout | Production server over localhost HTTP | Rebuilt production output plus unsigned manifest |
| `web-astro` | Astro 7.0.7 | Static content page | Preview server over localhost HTTP | Rebuilt static output plus unsigned manifest |
| `web-vite-react-pwa` | Vite 8.1.4 | Rendered React entry and service worker | Preview server over localhost HTTP | Rebuilt client output plus unsigned manifest |
| `backend-go-postgres` | Go 1.26.5 | HTTP health service, tests, SQL migration | Built server over localhost HTTP | Trimmed service binary plus unsigned manifest |
| `backend-fastapi-postgres` | FastAPI 0.139.0 / Python 3.14.6 | ASGI health service, TestClient contract, SQL migration | FastAPI server over localhost HTTP | Compiled source plus unsigned manifest |
| `backend-nestjs-postgres` | NestJS 11.1.28 | Nest controller/module/bootstrap and SQL migration | Ephemeral Nest HTTP server | Compiled ESM output plus unsigned manifest |
| `ios-swiftui` | Xcode 26.6 | SwiftUI Xcode app, unit target, UI target, shared scheme | iOS Simulator UI test | Unsigned `.xcarchive` plus manifest |
| `android-compose` | AGP 9.2.1 / Compose BOM 2026.06.01 | Compose activity, unit test, instrumented UI test | Connected emulator/device test | Unsigned release bundle plus manifest |
| `macos-swiftui` | Xcode 26.6 profile | SwiftUI package | Xcode build evidence; interactive QA remains explicit | Signing and notarization remain explicit |

Exact dependency and toolchain observations live in `registry/compatibility.v1.json`. Generated
manifests use only exact versions; no adapter emits a `latest` dependency.

## Status semantics

- `passed`: the required command ran successfully and emitted evidence.
- `blocked`: a command, security boundary, clean-worktree guard, capability contract, or release
  gate failed.
- `unverified`: the scaffold or required toolchain/simulator/emulator is unavailable, or its pinned
  version does not match. Missing infrastructure is never converted into success.

`packageDeployReady` reruns build, automated tests, and manual QA in order. It stops on the first
non-passing gate and only then executes the provider-neutral package command. The release manifest
records the exact commands, adapter version, registry observation date, `providerNeutral: true`,
and `signed: false`. Official adapters invoke pinned binaries directly rather than project-owned
package scripts. Tests require discovered source files and native structured results; builds
require adapter-specific semantic output. Web and backend manual QA is a harness-owned localhost
HTTP probe. Packaging copies a real output through a release roundtrip and verifies its hash.

## Trusted runner receipt channel

After the current harness invocation has freshly executed and correlated every required adapter
check, the CLI writes exactly one stdout line per evidence kind. The framing prefix contains a
literal tab:

```text
APP_HARNESS_ADAPTER_RECEIPT<TAB>{"schemaVersion":1,...}
```

The JSON object is strict and has only these fields:

```json
{
  "schemaVersion": 1,
  "adapterId": "web-next",
  "kind": "production_build",
  "argv": ["next", "build"],
  "outcome": "passed",
  "exitCode": 0,
  "stdoutHash": "64-lowercase-hex-characters",
  "artifacts": [
    {
      "path": ".app-harness/adapter-evidence/production_build.json",
      "sha256": "64-lowercase-hex-characters"
    }
  ]
}
```

The nine kinds are `production_build`, `unit_integration_tests`, `manual_surface_qa`,
`accessibility`, `security`, `migrations`, `backup_restore`, `release_bundle`, and `toolchain`.
`argv` contains 1–32 nonempty arguments; each argument is NUL-free and at most 1,024 Unicode
code points. The receipt stream retains its independent serialized-output cap.
Receipt artifacts are nonempty regular files contained below `.app-harness/adapter-evidence/`,
never links, and are hashed after persistence. The CLI validates the stored reports again before
emission. No receipt is emitted for failed, blocked, unverified, missing-toolchain, empty-output,
zero-test, malformed, escaped, linked, or hash-mismatched evidence.

Security reports recursively scan every contained source/configuration file while excluding known
dependency and build trees. The worker fails closed above its explicit 50,000-file safety bound;
it never treats a truncated prefix as success. Migration discovery is recursive, includes nested
application migration directories, and excludes dependency/build output before supported SQL is
applied twice to a disposable local database and integrity checked.

For adapters declared stateless, the child worker independently scans the project for migration
and database indicators and records an empty-indicator proof hash. For the PostgreSQL adapters,
`backup_restore` requires `APP_HARNESS_BACKUP_DATABASE_URL` plus
`APP_HARNESS_BACKUP_DATABASE_DISPOSABLE=yes`. The URL must identify an isolated disposable
database populated with the scaffolded `service_metadata` schema. The worker directly observes
state with `psql`, creates a real `pg_dump`, mutates the application table, restores it with
`pg_restore`, observes again, and compares hashes. Missing tools, missing explicit disposable
scope, unchanged mutation, or restore mismatch fail closed; no generic temporary-file roundtrip is
accepted. Accessibility is audited independently from surface QA,
and internal audit receipts carry the actual probe argv, outcome, exit code, and stdout hash. A
bundled child audit worker receives raw contained paths and independently creates the five audit
reports; parent-generated success flags or fact counts are rejected by the strict input schema.
Production, test, surface-QA, and release receipts are positionally correlated to their actual
adapter commands, so a successful receipt for a different command is rejected.

Receipt lines and the normal command result share stdout by design: consumers scan only lines with
the prefix, while the command result remains the final non-receipt JSON line. This is a generic
local protocol and does not name or contact an external service.

Project-local receipt and check JSONL files are audit records, not readiness authority. Their
hashes are intentionally not treated as proof against a project owner who can rewrite both data
and digest. `verify` always executes the selected official adapter's build, test, surface QA,
package, security, accessibility, migration, backup/restore, and toolchain checks in that process;
only the resulting in-memory check set can produce `ready: true`. A later `resume` repeats the
deploy-ready verification if no current-process check set exists. Forged, stale, replayed,
partially written, or tampered persisted receipts therefore fail closed without a local secret or
self-issued HMAC.

## Existing projects and resume

Create mode writes only artifacts owned by the selected adapter. Resume mode retains matching
completed product and Codex stage output; release verification is freshly re-executed across a
process restart before readiness is restored. Extend mode requires a clean Git worktree and a
matching adapter marker. A different existing stack is preserved and returns
`existing_stack_mismatch`; migration requires an explicit higher-level decision. A stale
compatibility lock similarly blocks rather than mutating project files.

Scaffold and release-manifest paths are confined to the project root. Existing conflicting files,
hard links, nested symbolic links, and symbolic-link project roots fail closed.
