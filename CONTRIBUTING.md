# Contributing to App Development Harness

App Development Harness is an early-stage, independently maintained CLI and Codex plugin. Contributions should improve reproducibility, safe execution, or the accuracy of verification results.

## Reproduce a problem

Open an issue with the source revision, operating system, Bun and Node versions, a small synthetic input, expected behavior, and the result you observed. Remove credentials, personal data, local account paths, and customer material. An issue is useful even when you cannot propose a fix.

## Propose a change

Keep a pull request focused on one behavior. Explain the trigger, the resulting behavior, and the checks you ran. Preserve unrelated files and existing run records. Add a regression test when a change affects execution, concurrency, permissions, or artifact validation.

Use Bun 1.3.11 for the locked dependency tree. After reviewing dependencies, run `bun install --frozen-lockfile`, then `bun run check`, `bun test ./tests/ --timeout 20000`, and `bun run build`. Tests use synthetic inputs and local fixtures; running live models is a separate activity that requires your own authorized account and budget.

## Respect project boundaries

Do not submit third-party materials unless you have the right to distribute them under the applicable license. Keep required notices. Report incomplete checks as blocked or unverified. A source test does not establish a product's device, payment, security, or public-release readiness.

Contributions are reviewed by a maintainer before inclusion. This project does not promise a response time or an automatic merge.
