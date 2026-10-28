# Check file evidence for a maintenance record

This Python 3.11 standard-library tool checks identifiers, dates, exit codes and evidence hashes. It makes no network requests or model calls. It establishes no grant eligibility, identity, continuous maintenance or independent adoption.

## Run the checker and tests

```sh
python3 check_evidence.py --root /path/to/evidence-root --input /path/to/record.json
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Input is a JSON object with `schemaVersion: 1` and nonempty `records`. Each record needs a unique `id`, `kind` (`local`/`public`), `status` (`passed`/`failed`), integer `exitCode`, boolean `independentUser`, nonnegative integer `providerCalls`, `version`, timezone-aware `observedAt`, and `evidence` entries with root-relative `path` and SHA-256 `sha256`.

## Interpret the result carefully

A public record also needs a GitHub `publicURL`. Its format is checked but it is not fetched. Symlinks, escaping paths, changed files, future dates, duplicate IDs and inconsistent outcomes are rejected. Failed runs can use nonzero codes. A structurally valid packet does not make its author's statements true.
