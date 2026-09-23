#!/bin/sh
# Vendor the zero-dependency vibe-usage CLI (bin/ + src/) from the sibling
# vibe-usage repo into ./cli so the Electron app can run the daemon without
# requiring a global npm install. Re-run after CLI changes.
set -e
SRC="${1:-../vibe-usage}"
if [ ! -f "$SRC/bin/vibe-usage.js" ]; then
  echo "error: $SRC/bin/vibe-usage.js not found (pass path as arg 1)" >&2
  exit 1
fi
rm -rf cli
mkdir -p cli
# Vendor the committed state (HEAD), not the working tree — WIP stays out.
git -C "$SRC" archive HEAD bin src package.json | tar -x -C cli
echo "synced $SRC@HEAD (bin, src, package.json) -> ./cli"
