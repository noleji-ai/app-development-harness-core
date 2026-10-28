#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
ARCHIVE=${1:-$ROOT/releases/noleji-launch-mac-transfer-$VERSION.zip}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/noleji-mac-transfer-verify.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

[ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || {
  printf 'transfer archive is missing or unsafe\n' >&2
  exit 1
}
unzip -tq "$ARCHIVE" >/dev/null
zipinfo -1 "$ARCHIVE" > "$WORK/entries.txt"
if awk '
  /^\// { bad=1 }
  /(^|\/)\.\.(\/|$)/ { bad=1 }
  /(^|\/)(\.git|\.omo|\.omx|\.app-harness|\.playwright-cli|node_modules|releases)(\/|$)/ { bad=1 }
  /(^|\/)\.DS_Store$/ { bad=1 }
  END { exit bad ? 0 : 1 }
' "$WORK/entries.txt"; then
  printf 'transfer archive contains a forbidden or unsafe path\n' >&2
  exit 1
fi
if zipinfo -l "$ARCHIVE" | awk '$1 ~ /^[bclps]/ { found=1 } END { exit found ? 0 : 1 }'; then
  printf 'transfer archive contains a link, device, socket, or special entry\n' >&2
  exit 1
fi

for required in \
  noleji-launch-mac-transfer/START-HERE.md \
  noleji-launch-mac-transfer/SHA256SUMS \
  noleji-launch-mac-transfer/artifacts/app-development-harness-$VERSION-macos.zip \
  noleji-launch-mac-transfer/artifacts/app-development-harness-$VERSION-macos.zip.sha256 \
  noleji-launch-mac-transfer/artifacts/noleji-launch-source.tar.gz \
  noleji-launch-mac-transfer/artifacts/noleji-launch-source.tar.gz.sha256
do
  grep -Fxq "$required" "$WORK/entries.txt" || {
    printf 'transfer archive is missing %s\n' "$required" >&2
    exit 1
  }
done

unzip -q "$ARCHIVE" -d "$WORK/extracted"
BUNDLE="$WORK/extracted/noleji-launch-mac-transfer"
(cd "$BUNDLE" && shasum -a 256 -c SHA256SUMS >/dev/null)
(cd "$BUNDLE/artifacts" && shasum -a 256 -c "app-development-harness-$VERSION-macos.zip.sha256" >/dev/null)
(cd "$BUNDLE/artifacts" && shasum -a 256 -c noleji-launch-source.tar.gz.sha256 >/dev/null)
"$ROOT/scripts/verify-release.sh" \
  "$BUNDLE/artifacts/app-development-harness-$VERSION-macos.zip" >/dev/null
mkdir -p "$WORK/source"
tar -xzf "$BUNDLE/artifacts/noleji-launch-source.tar.gz" -C "$WORK/source"
SOURCE_ROOT="$WORK/source/noleji-launch"
[ -f "$SOURCE_ROOT/scripts/release/verify-source-archive.sh" ] || {
  printf 'Noleji source verifier is unavailable in the transfer archive\n' >&2
  exit 1
}
sh "$SOURCE_ROOT/scripts/release/verify-source-archive.sh" \
  "$BUNDLE/artifacts/noleji-launch-source.tar.gz" >/dev/null

for text in 'Xcode 26.6' 'PostgreSQL 18.4' '127.0.0.1' 'Tailscale DNS' 'Tailscale IP' \
  '사용자 지정 HTTPS' '$app-harness doctor' '$app-harness init' \
  '$app-harness dashboard --open' 'doctor --project' 'status --project' \
  'dashboard --project' 'run --project' '외부 배포 금지' '미완료 검토를 그대로 이어야 합니다'; do
  grep -Fq "$text" "$BUNDLE/START-HERE.md" || {
    printf 'START-HERE is missing required guidance: %s\n' "$text" >&2
    exit 1
  }
done
if rg -n 'F1/F2.*(승인|완료)|F3.*APPROVE|APPROVE[[:space:]]*—?[[:space:]]*100/100' \
  "$BUNDLE/START-HERE.md" >/dev/null; then
  printf 'START-HERE contains a stale internal review approval\n' >&2
  exit 1
fi
if rg -n '/Users/[^S]|/private/var/|/var/folders/|@[A-Z0-9_]+@|BEGIN [A-Z ]*PRIVATE KEY' \
  "$BUNDLE/START-HERE.md" >/dev/null; then
  printf 'START-HERE contains unsafe private material\n' >&2
  exit 1
fi

printf 'Mac transfer verification passed: %s entries, %s regular files\n' \
  "$(wc -l < "$WORK/entries.txt" | tr -d ' ')" \
  "$(find "$BUNDLE" -type f | wc -l | tr -d ' ')"
