#!/bin/sh
# Refresh the monorepo copies of the permanent internal-browser extensions.
# Policy: no symlinks. Copies live in the monorepo under intake/extensions/;
# the frame loads ONLY these copies. Run this after updating an original.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/apps/frame/extensions"

copy() {
  src="$1"; dst="$DEST/$2"
  if [ ! -f "$src/manifest.json" ]; then
    echo "SKIP: original missing ($src)" >&2
    return 1
  fi
  mkdir -p "$dst"
  rsync -a --delete --exclude=".git" "$src/" "$dst/"
  name=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['name'])" "$dst/manifest.json")
  ver=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('version','?'))" "$dst/manifest.json")
  echo "OK: $2 <- $src ($name v$ver)"
}

copy "/Volumes/SanDisk1Tb/open-anvil/extension" open-anvil
copy "/Volumes/Storage/Floyd TTY Bridge for Chrome/extension" floyd-tty-bridge
