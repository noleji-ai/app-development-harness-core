#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
BUNDLE_NAME="app-development-harness-bundle"
OUTPUT_DIRECTORY="$ROOT/releases"
ARCHIVE="$OUTPUT_DIRECTORY/app-development-harness-$VERSION-macos.zip"
STAGING=$(mktemp -d "${TMPDIR:-/tmp}/app-harness-package.XXXXXX")
BUNDLE="$STAGING/$BUNDLE_NAME"
PLUGIN="$BUNDLE/plugins/app-development-harness"

cleanup() {
  rm -rf "$STAGING"
}
trap cleanup EXIT INT TERM

mkdir -p "$BUNDLE/.agents/plugins" "$PLUGIN" "$OUTPUT_DIRECTORY"
cp "$ROOT/packaging/.agents/plugins/marketplace.json" "$BUNDLE/.agents/plugins/marketplace.json"
cp "$ROOT/MAC_MINI_HANDOFF.md" "$BUNDLE/README-FIRST.md"

for path in \
  .codex-plugin \
  assets \
  docs \
  registry \
  skills \
  src \
  tests
do
  ditto "$ROOT/$path" "$PLUGIN/$path"
done

mkdir -p "$PLUGIN/packaging/.agents/plugins" "$PLUGIN/scripts"
cp "$ROOT/packaging/.agents/plugins/marketplace.json" \
  "$PLUGIN/packaging/.agents/plugins/marketplace.json"
cp "$ROOT/scripts/package-release.sh" "$ROOT/scripts/verify-release.sh" "$PLUGIN/scripts/"
rm -f \
  "$PLUGIN/tests/contract/macos-test-scheme.test.ts" \
  "$PLUGIN/tests/contract/official-adapters.test.ts"

for file in \
  .gitignore \
  ADAPTERS.md \
  CONTRIBUTING.md \
  biome.json \
  bun.lock \
  DESIGN.md \
  hooks.json \
  LICENSE \
  SECURITY.md \
  THIRD-PARTY-NOTICES.txt \
  MAC_MINI_HANDOFF.md \
  package.json \
  PROVENANCE.md \
  README.md \
  tsconfig.json
do
  cp "$ROOT/$file" "$PLUGIN/$file"
done

mkdir -p "$PLUGIN/dist"
for runtime in cli.js internal-audit-worker.js surface-qa-worker.js; do
  cp "$ROOT/dist/$runtime" "$PLUGIN/dist/$runtime"
  chmod 755 "$PLUGIN/dist/$runtime"
done
find "$BUNDLE" -type f -name .DS_Store -delete

if find "$BUNDLE" -type l -print -quit | grep -q .; then
  printf 'bundle contains a symbolic link; packaging is fail-closed\n' >&2
  exit 1
fi

find "$BUNDLE" -exec touch -h -t 202401010000 {} +
rm -f "$ARCHIVE"
(cd "$STAGING" && find "$BUNDLE_NAME" -print | LC_ALL=C sort | COPYFILE_DISABLE=1 zip -q -X "$ARCHIVE" -@)
(
  cd "$OUTPUT_DIRECTORY"
  shasum -a 256 "$(basename "$ARCHIVE")" >"$(basename "$ARCHIVE").sha256"
)
printf '%s\n' "$ARCHIVE"
