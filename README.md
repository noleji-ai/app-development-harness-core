# App Development Harness Core

A local-first CLI and Codex plugin for resumable app-development work, explicit decisions and inspectable verification records. The aim is reusable infrastructure for small open-source teams. [한국어 안내](README.ko.md)

This early source baseline derives from App Development Harness 1.2.0. It starts with a curated snapshot and no private Git history. External adoption, school deployments and OpenAI program selection have not been established. See [provenance](PROVENANCE.md) and [current verification](docs/verification.md).

## Try initialization without calling a model

The checked baseline uses macOS and Node.js 22 or later. Included Node bundles let you inspect initialization without installing dependencies. From this directory:

```sh
node dist/cli.js --help
DEMO_PROJECT=$(mktemp -d)
node dist/cli.js init --project "$DEMO_PROJECT" --mode create
node dist/cli.js status --project "$DEMO_PROJECT"
node dist/cli.js doctor --project "$DEMO_PROJECT"
```

Status should report `initialized: true` and `activeRun: null`. Initialization does not start development. Keep the temporary folder to inspect its records. Other systems and real provider behavior need separate verification.

## Inspect the development workflow

Commands include `init`, `run`, `resume`, `status`, `verify`, `dashboard`, `doctor` and `upgrade`. Project records live in `.app-harness/`. Explicit decisions, run identity and evidence help distinguish completed checkpoints from missing verification.

`run` and `resume` can execute Codex and project tools. Review account access, repository permissions, SDKs and spending limits first. ChatGPT subscriptions and API credits are different benefits. No deployment or grant application is performed by the initialization example.

For source development, review the pinned dependencies and use Bun 1.3.11:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test ./tests/ --timeout 20000
bun run build
```

Read the [local guide](docs/getting-started.md), [adapter contract](ADAPTERS.md), [model policy](docs/model-execution-policy.md) and [contribution guide](CONTRIBUTING.md). A [Python evidence checker](tools/maintenance-evidence/README.md) accompanies the source.

## Contribute reproducible improvements

Useful work includes failure cases, compatibility findings, recovery checks and documentation corrections. Include the exact version and distinguish fixtures from live-provider observations. Remove credentials, private workspaces and customer/student data.

The [maintenance plan](MAINTENANCE.md) and [change log](CHANGELOG.md) separate prepared changes, published source and observed use. Plans do not guarantee a release schedule or free support. Sensitive reports follow [SECURITY.md](SECURITY.md).

## License and project status

The existing [MIT license](LICENSE) and [third-party notices](THIRD-PARTY-NOTICES.txt) are retained. Generated reference artwork and private operating history are excluded. This independent project implies no endorsement or affiliation with OpenAI.
