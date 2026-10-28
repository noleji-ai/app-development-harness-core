#!/bin/sh

set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf 'usage: package-mac-transfer.sh <noleji-source.tar.gz> [output-directory]\n' >&2
  exit 64
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
NOLEJI_ARCHIVE=$(CDPATH= cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")
OUTPUT_DIRECTORY=${2:-$ROOT/releases}
HARNESS_ARCHIVE="$ROOT/releases/app-development-harness-$VERSION-macos.zip"
BUNDLE_NAME="noleji-launch-mac-transfer"
ARCHIVE="$OUTPUT_DIRECTORY/noleji-launch-mac-transfer-$VERSION.zip"
STAGING=$(mktemp -d "${TMPDIR:-/tmp}/noleji-mac-transfer.XXXXXX")
BUNDLE="$STAGING/$BUNDLE_NAME"

cleanup() {
  rm -rf "$STAGING"
}
trap cleanup EXIT HUP INT TERM

for artifact in "$HARNESS_ARCHIVE" "$NOLEJI_ARCHIVE"; do
  [ -f "$artifact" ] && [ ! -L "$artifact" ] || {
    printf 'required artifact is missing or unsafe: %s\n' "$artifact" >&2
    exit 1
  }
  [ -f "$artifact.sha256" ] && [ ! -L "$artifact.sha256" ] || {
    printf 'required sidecar is missing or unsafe: %s.sha256\n' "$artifact" >&2
    exit 1
  }
  (cd "$(dirname -- "$artifact")" && shasum -a 256 -c "$(basename -- "$artifact").sha256")
done

"$ROOT/scripts/verify-release.sh" "$HARNESS_ARCHIVE" >/dev/null
NOLEJI_ROOT=$(CDPATH= cd -- "$(dirname -- "$NOLEJI_ARCHIVE")/../.." && pwd)
"$NOLEJI_ROOT/scripts/release/verify-source-archive.sh" "$NOLEJI_ARCHIVE" >/dev/null

HARNESS_SHA256=$(shasum -a 256 "$HARNESS_ARCHIVE" | awk '{print $1}')
NOLEJI_SHA256=$(shasum -a 256 "$NOLEJI_ARCHIVE" | awk '{print $1}')
HARNESS_ENTRIES=$(zipinfo -1 "$HARNESS_ARCHIVE" | wc -l | tr -d ' ')
HARNESS_FILES=$(zipinfo -1 "$HARNESS_ARCHIVE" | awk '!/\/$/' | wc -l | tr -d ' ')
NOLEJI_ENTRIES=$(tar -tzf "$NOLEJI_ARCHIVE" | wc -l | tr -d ' ')
NOLEJI_FILES=$(tar -tzf "$NOLEJI_ARCHIVE" | awk '!/\/$/' | wc -l | tr -d ' ')

mkdir -p "$BUNDLE/artifacts" "$OUTPUT_DIRECTORY"
cp "$HARNESS_ARCHIVE" "$HARNESS_ARCHIVE.sha256" "$BUNDLE/artifacts/"
cp "$NOLEJI_ARCHIVE" "$NOLEJI_ARCHIVE.sha256" "$BUNDLE/artifacts/"
sed \
  -e "s/@HARNESS_SHA256@/$HARNESS_SHA256/g" \
  -e "s/@HARNESS_ENTRIES@/$HARNESS_ENTRIES/g" \
  -e "s/@HARNESS_FILES@/$HARNESS_FILES/g" \
  -e "s/@NOLEJI_SHA256@/$NOLEJI_SHA256/g" \
  -e "s/@NOLEJI_ENTRIES@/$NOLEJI_ENTRIES/g" \
  -e "s/@NOLEJI_FILES@/$NOLEJI_FILES/g" \
  "$ROOT/packaging/START-HERE.template.md" > "$BUNDLE/START-HERE.md"
(
  cd "$BUNDLE"
  find artifacts -type f -print | LC_ALL=C sort | xargs shasum -a 256 > SHA256SUMS
)

if find "$BUNDLE" -type l -print -quit | grep -q .; then
  printf 'transfer bundle contains a symbolic link; packaging is fail-closed\n' >&2
  exit 1
fi
if rg -n '/Users/[^S]|/private/var/|/var/folders/|@[A-Z0-9_]+@' \
  "$BUNDLE/START-HERE.md" >/dev/null; then
  printf 'START-HERE contains a private path or unresolved placeholder\n' >&2
  exit 1
fi

find "$BUNDLE" -exec touch -h -t 202401010000 {} +
rm -f "$ARCHIVE"
(cd "$STAGING" && find "$BUNDLE_NAME" -print | LC_ALL=C sort | COPYFILE_DISABLE=1 zip -q -X "$ARCHIVE" -@)
(
  cd "$OUTPUT_DIRECTORY"
  shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256"
)
printf '%s\n' "$ARCHIVE"
