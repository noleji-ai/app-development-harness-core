# Check the CLI locally before running a model

This example creates a new local project record, reads its status, and checks its lock metadata. It does not ask a model to build an application.

## Prepare the source

Use macOS, Node.js 22 or later, and Bun 1.3.11 for this source baseline. The CI configuration targets macOS. Other operating systems have not been verified by this preparation.

After obtaining the source and reviewing its dependencies, install the versions in `bun.lock` with `bun install --frozen-lockfile`. Run `bun run check`, `bun test ./tests/ --timeout 20000`, and `bun run build`. A missing SDK can still block an individual product adapter after these source checks pass.

## Create and inspect a local record

Run these commands from the repository root. The example uses a fresh temporary folder so it does not touch an existing app.

```sh
DEMO_PROJECT=$(mktemp -d)
node dist/cli.js --help
node dist/cli.js init --project "$DEMO_PROJECT" --mode create
node dist/cli.js status --project "$DEMO_PROJECT"
node dist/cli.js doctor --project "$DEMO_PROJECT"
```

`init` reports an initialized record. `status` reports `initialized: true` and `activeRun: null`, because initialization alone does not start a development run. `doctor` reports whether the initialized configuration and lock protocol are compatible. Inspect the JSON and the new `.app-harness` folder. Keep the folder if you want to inspect the result later.

## Start paid or account-backed work deliberately

The `run` and `resume` commands can invoke Codex and project tools. Before using them, verify your account, provider terms, available SDKs, project permissions, and spending limit. ChatGPT subscription access and API billing are separate. No OpenAI grant, free quota, or school deployment is established by this example.

See the [README](../README.md), [adapter contract](../ADAPTERS.md), and [contribution guide](../CONTRIBUTING.md) for the existing command and verification behavior.
