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
