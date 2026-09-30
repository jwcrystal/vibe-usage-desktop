#!/bin/sh
# Vendor the zero-dependency vibe-usage CLI (bin/ + src/ + package.json) from
# the sibling vibe-usage repo into ./cli so the Electron app can run the daemon
# without requiring a global npm install. The sibling checkout should be a
# clone of the project fork https://github.com/jwcrystal/vibe-usage
# (based on vibe-cafe/vibe-usage).
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
cat > cli/NOTICE <<'EOF'
This directory is a vendored snapshot of the vibe-usage CLI
(bin/ + src/ + package.json), taken from this project's fork:

  https://github.com/jwcrystal/vibe-usage

The fork is based on the upstream project and may carry local
modifications on top of it:

  https://github.com/vibe-cafe/vibe-usage

Re-synced from a sibling checkout by scripts/sync-cli.sh.
Upstream code is (c) vibe-cafe, MIT (declared in the vendored package.json);
fork modifications are (c) CrytsalTraveler, MIT. The notice below applies to
all code in this directory.

MIT License

Copyright (c) vibe-cafe / vibe-usage contributors
Copyright (c) 2026 CrytsalTraveler (fork modifications)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF
echo "synced $SRC@HEAD (bin, src, package.json) -> ./cli (+ NOTICE)"
