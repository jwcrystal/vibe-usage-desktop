#!/bin/sh
# Vendor the zero-dependency vibe-usage CLI (bin/ + src/ + package.json) from
# the sibling vibe-usage repo into ./cli so the Electron app can run the daemon
# without requiring a global npm install.
#
# Called automatically before `start` and `dist*` — with a sibling checkout
# present the snapshot can never go stale. Without one, keep the committed
# snapshot and exit 0 so other machines / CI still build.
set -e
SRC="${1:-../vibe-usage}"
if [ ! -d "$SRC/.git" ]; then
  echo "warn: $SRC is not a git checkout — keeping vendored cli/ snapshot."
  exit 0
fi
rm -rf cli
mkdir -p cli
# Vendor the committed state (HEAD), not the working tree — WIP stays out.
git -C "$SRC" archive HEAD bin src package.json | tar -x -C cli
echo "synced $SRC@HEAD (bin, src, package.json) -> ./cli"
