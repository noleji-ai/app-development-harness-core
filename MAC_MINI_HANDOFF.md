# Mac mini Codex handoff

This bundle is a local Codex marketplace containing the `app-development-harness` plugin. The
runtime is already bundled in `dist/cli.js`; Node.js 22 or newer is the verified runtime, while Bun
is needed only to rebuild or run the source test suite.

The compatibility lock requires Xcode 26.6 for approved Apple release verification. A lower Xcode,
missing SDK, simulator, signing identity, or archive remains `blocked` or `unverified`; it is never
converted into a release pass.

## Install on the other Mac

1. Keep the ZIP and its adjacent `.sha256` file together, then verify it before extraction:

```sh
shasum -a 256 -c app-development-harness-1.2.0-macos.zip.sha256
```

2. Extract the ZIP without moving files inside the extracted bundle.
3. In Terminal, set `BUNDLE_ROOT` to the extracted `app-development-harness-bundle` directory.
4. Register the local marketplace and install the plugin:

```sh
export BUNDLE_ROOT="/absolute/path/to/app-development-harness-bundle"
codex plugin marketplace add "$BUNDLE_ROOT"
codex plugin add app-development-harness@app-harness-local
codex plugin list --marketplace app-harness-local --available
```

5. Start a new Codex thread. New threads are the reliable boundary for loading newly installed
   skills and hooks.

Do not copy `node_modules` from the source Mac. The distributed runtime has its only dependency
bundled into `dist/cli.js`.

## Prompt for the new Codex thread

```text
먼저 이 번들의 README-FIRST.md와 설치된 app-harness SKILL.md를 끝까지 읽어.
app-development-harness 플러그인이 설치되었는지 확인하고 `$app-harness doctor`로 준비 상태를
점검해. 아직 대상 프로젝트를 임의로 초기화하거나 외부 배포하지 마. 신규/대규모 앱 구축에만
전체 하네스를 사용하고, 질문·리뷰·작은 수정에는 자동 적용하지 마. 준비 결과에는 플러그인 버전,
8개 명령, 로컬 대시보드 보안 경계, 사용 가능한 SDK/시뮬레이터와 차단 항목을 보고해.
```

## Direct preflight without installing

From the extracted bundle root:

```sh
node plugins/app-development-harness/dist/cli.js doctor --project "$PWD"
node plugins/app-development-harness/dist/cli.js hook user-prompt-submit \
  "Build a new application from scratch"
```

The first command may report `ok: false` before a project has been initialized; that means the
binary loaded correctly but no `.app-harness/` state exists in the chosen project yet.

For a clean extracted project, create a local Git baseline before `extend`; transfer bundles do not
include `.git` or `.app-harness` state:

```sh
export PROJECT_ROOT="/absolute/path/to/project"
git -C "$PROJECT_ROOT" init
git -C "$PROJECT_ROOT" add .
git -C "$PROJECT_ROOT" -c user.name="Local Handoff" \
  -c user.email="local-handoff@example.invalid" commit -m "Create local handoff baseline"
node "$BUNDLE_ROOT/plugins/app-development-harness/dist/cli.js" init \
  --project "$PROJECT_ROOT" --mode extend
node "$BUNDLE_ROOT/plugins/app-development-harness/dist/cli.js" doctor --project "$PROJECT_ROOT"
node "$BUNDLE_ROOT/plugins/app-development-harness/dist/cli.js" status --project "$PROJECT_ROOT"
node "$BUNDLE_ROOT/plugins/app-development-harness/dist/cli.js" dashboard \
  --project "$PROJECT_ROOT" --open
```

Use `run --request "..."` only for a new or major end-to-end build. Use `resume` only when the
same project's `.app-harness/` state is present and `doctor` reports a compatible lock protocol.

Keep the control plane, dashboard, and web runtime bound to `127.0.0.1`. If remote access over an
already approved Tailscale network is required, use an authenticated SSH port forward so the
services remain loopback-only. Do not place tailnet identities, IPs, auth keys, credentials, or
private connection logs in project state or the transfer bundle. Tailscale ACL/device changes,
credential use, DNS, deployment, signing, and store submission require separate approval.

For an existing project, inspect `lockProtocol.status` in the doctor output before running
`upgrade`. `active-legacy-lock` is bounded and retryable after the old process exits.
`recovery-required` is fail-closed: stop all harness processes and follow the quarantine guidance
in the plugin README. Never delete a reported legacy base lock while any harness process can race
to acquire it.

## Source rebuild and verification

Only if Bun is installed:

```sh
cd "$BUNDLE_ROOT/plugins/app-development-harness"
bun install --frozen-lockfile
bun run check
bun test
bun run build
```

The harness must leave unavailable Xcode, Android SDK, simulators, or emulators as `blocked` or
`unverified`. It must never replace those checks with a success result.
