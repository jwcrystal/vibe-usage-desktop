#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SERVER_SRC="${VIBE_USAGE_SERVER_DIR:-$ROOT/../vibe-usage-local-server}"

check_diff() {
  label=$1
  source=$2
  vendor=$3
  if [ ! -d "$source" ] || [ ! -d "$vendor" ]; then
    echo "warn: cannot compare $label (source or vendor directory missing)"
    return
  fi
  if diff -qr "$source" "$vendor"; then
    echo "ok: $label vendor matches source"
  else
    echo "warn: $label vendor differs from source; review, then sync manually"
  fi
}

check_diff server "$SERVER_SRC/src" "$ROOT/server"

# The cli vendor is compared against the ref it is taken from, not the sibling's
# working tree, so a checkout with work in progress does not read as drift.
CLI_SRC="${VIBE_USAGE_CLI_DIR:-$ROOT/../vibe-usage}"
CLI_REF="${VIBE_USAGE_CLI_REF:-main}"
if [ ! -d "$CLI_SRC/.git" ]; then
  echo "warn: cannot compare cli ($CLI_SRC is not a git checkout)"
elif SHA=$(git -C "$CLI_SRC" rev-parse --verify --quiet "$CLI_REF^{commit}" 2>/dev/null); then
  CLI_TMP=$(mktemp -d)
  trap 'rm -rf "$CLI_TMP"' EXIT
  git -C "$CLI_SRC" archive "$SHA" src | tar -x -C "$CLI_TMP"
  check_diff cli "$CLI_TMP/src" "$ROOT/cli/src"
else
  echo "warn: cannot compare cli ($CLI_SRC has no commit at '$CLI_REF')"
fi
