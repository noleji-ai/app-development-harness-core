#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EXPECTED_VERSION=1.2.0
VERSION=$(node -p "require('$ROOT/package.json').version")
ARCHIVE=${1:-$ROOT/releases/app-development-harness-$VERSION-macos.zip}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/app-harness-verify.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

[ "$VERSION" = "$EXPECTED_VERSION" ] || {
  printf 'source package version must be %s, found %s\n' "$EXPECTED_VERSION" "$VERSION" >&2
  exit 1
}

[ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || {
  printf 'release archive is missing or unsafe\n' >&2
  exit 1
}

unzip -tq "$ARCHIVE" >/dev/null
zipinfo -1 "$ARCHIVE" >"$WORK/entries.txt"
if awk '
  /^\// { bad=1 }
  /(^|\/)\.\.(\/|$)/ { bad=1 }
  /(^|\/)(\.git|\.omo|\.playwright-cli|node_modules|releases)(\/|$)/ { bad=1 }
  /(^|\/)\.DS_Store$/ { bad=1 }
  /(^|\/)\.env($|\.)/ && !/(^|\/)\.env\.example$/ { bad=1 }
  END { exit bad ? 0 : 1 }
' "$WORK/entries.txt"; then
  printf 'release archive contains a forbidden or unsafe path\n' >&2
  exit 1
fi
if zipinfo -l "$ARCHIVE" | awk '$1 ~ /^[bclps]/ { found=1 } END { exit found ? 0 : 1 }'; then
  printf 'release archive contains a link, device, socket, or special entry\n' >&2
  exit 1
fi

for required in \
  app-development-harness-bundle/README-FIRST.md \
  app-development-harness-bundle/.agents/plugins/marketplace.json \
  app-development-harness-bundle/plugins/app-development-harness/.codex-plugin/plugin.json \
  app-development-harness-bundle/plugins/app-development-harness/skills/app-harness/SKILL.md \
  app-development-harness-bundle/plugins/app-development-harness/dist/cli.js \
  app-development-harness-bundle/plugins/app-development-harness/dist/internal-audit-worker.js \
  app-development-harness-bundle/plugins/app-development-harness/dist/surface-qa-worker.js \
  app-development-harness-bundle/plugins/app-development-harness/ADAPTERS.md \
  app-development-harness-bundle/plugins/app-development-harness/LICENSE \
  app-development-harness-bundle/plugins/app-development-harness/PROVENANCE.md \
  app-development-harness-bundle/plugins/app-development-harness/registry/compatibility.v1.json
do
  grep -Fxq "$required" "$WORK/entries.txt" || {
    printf 'release archive is missing %s\n' "$required" >&2
    exit 1
  }
done

for forbidden in \
  app-development-harness-bundle/plugins/app-development-harness/scripts/package-mac-transfer.sh \
  app-development-harness-bundle/plugins/app-development-harness/scripts/verify-mac-transfer.sh \
  app-development-harness-bundle/plugins/app-development-harness/packaging/START-HERE.template.md
do
  if grep -Fxq "$forbidden" "$WORK/entries.txt"; then
    printf 'generic plugin archive contains transfer-only file: %s\n' "$forbidden" >&2
    exit 1
  fi
done

unzip -q "$ARCHIVE" -d "$WORK/extracted"
BUNDLE="$WORK/extracted/app-development-harness-bundle"
PLUGIN="$BUNDLE/plugins/app-development-harness"
PRODUCT_PATTERN=$(printf '%s%s' 'Nol' 'eji')
if (
  cd "$PLUGIN"
  rg --hidden -a -i -n --pcre2 \
    --glob '!/LICENSE' \
    --glob '!/PROVENANCE.md' \
    "${PRODUCT_PATTERN}|${PRODUCT_PATTERN}RunnerShellCore|prj_[0-9A-HJKMNP-TV-Z]{26}" \
    .
); then
  printf 'generic plugin archive contains service-specific strings\n' >&2
  exit 1
fi
node -e '
  const fs = require("node:fs");
  const expectedVersion = "1.2.0";
  const marketplace = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const packageManifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const plugin = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  if (marketplace.name !== "app-harness-local") throw new Error("unexpected marketplace name");
  if (packageManifest.version !== expectedVersion) throw new Error("unexpected package version");
  for (const requiredFile of ["LICENSE", "PROVENANCE.md"]) {
    if (!packageManifest.files.includes(requiredFile)) {
      throw new Error(`package manifest is missing ${requiredFile}`);
    }
  }
  if (plugin.name !== "app-development-harness") throw new Error("unexpected plugin name");
  if (plugin.version !== expectedVersion) throw new Error("unexpected plugin version");
' "$BUNDLE/.agents/plugins/marketplace.json" "$PLUGIN/package.json" "$PLUGIN/.codex-plugin/plugin.json"
node "$PLUGIN/dist/cli.js" --help | grep -q '^Usage: app-harness'
COMMANDS=$(node "$PLUGIN/dist/cli.js" --help | awk '/^  (init|run|resume|status|verify|dashboard|doctor|upgrade)$/ { print $1 }')
[ "$COMMANDS" = "$(printf 'init\nrun\nresume\nstatus\nverify\ndashboard\ndoctor\nupgrade')" ] || {
  printf 'release CLI does not expose exactly the eight public commands\n' >&2
  exit 1
}
RUNTIME_VERSION=$(node "$PLUGIN/dist/cli.js" doctor --project "$WORK/runtime-probe" \
  | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => { process.stdout.write(JSON.parse(input).harness); });
    ')
[ "$RUNTIME_VERSION" = "$EXPECTED_VERSION" ] || {
  printf 'runtime harness version must be %s, found %s\n' \
    "$EXPECTED_VERSION" "$RUNTIME_VERSION" >&2
  exit 1
}

for relative in \
  dist/cli.js \
  dist/internal-audit-worker.js \
  dist/surface-qa-worker.js \
  .codex-plugin/plugin.json \
  LICENSE \
  THIRD-PARTY-NOTICES.txt \
  package.json \
  PROVENANCE.md \
  skills/app-harness/SKILL.md \
  registry/compatibility.v1.json
do
  cmp -s "$ROOT/$relative" "$PLUGIN/$relative" || {
    printf 'release file differs from the frozen source: %s\n' "$relative" >&2
    exit 1
  }
done

SYSTEM_SKILLS=${CODEX_SYSTEM_SKILLS_ROOT:-$HOME/.codex/skills/.system}
[ -f "$SYSTEM_SKILLS/plugin-creator/scripts/validate_plugin.py" ] || {
  printf 'Codex plugin validator is unavailable\n' >&2
  exit 1
}
[ -f "$SYSTEM_SKILLS/skill-creator/scripts/quick_validate.py" ] || {
  printf 'Codex skill validator is unavailable\n' >&2
  exit 1
}
UV_CACHE_DIR="$WORK/uv-cache" uv run --quiet --with pyyaml \
  "$SYSTEM_SKILLS/plugin-creator/scripts/validate_plugin.py" "$PLUGIN" >/dev/null
UV_CACHE_DIR="$WORK/uv-cache" uv run --quiet --with pyyaml \
  "$SYSTEM_SKILLS/skill-creator/scripts/quick_validate.py" \
  "$PLUGIN/skills/app-harness" >/dev/null

mkdir -p "$WORK/codex-home/.codex"
HOME="$WORK/codex-home" CODEX_HOME="$WORK/codex-home/.codex" \
  codex plugin marketplace add "$BUNDLE" --json >/dev/null
HOME="$WORK/codex-home" CODEX_HOME="$WORK/codex-home/.codex" \
  codex plugin add app-development-harness@app-harness-local --json >/dev/null
HOME="$WORK/codex-home" CODEX_HOME="$WORK/codex-home/.codex" \
  codex plugin list --marketplace app-harness-local --available --json \
  | jq -e '.installed | any(.name == "app-development-harness" and .installed == true)' >/dev/null
grep -q 'Prompt for the new Codex thread' "$BUNDLE/README-FIRST.md"

printf 'Release verification passed: %s files; handoff prompt and CLI are readable.\n' \
  "$(wc -l <"$WORK/entries.txt" | tr -d ' ')"
