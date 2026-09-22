#!/bin/sh
# Vendor the zero-dependency server from the sibling vibe-usage-local-server repo
# into ./server so the Electron app bundles it. Re-run after server changes.
set -e
SRC="${1:-../vibe-usage-local-server}"
if [ ! -f "$SRC/src/server.js" ]; then
  echo "error: $SRC/src/server.js not found (pass path as arg 1)" >&2
  exit 1
fi
rm -rf server
cp -R "$SRC/src" server
echo "synced $SRC/src -> ./server"
