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

# Donor originals: set env vars pointing at your working copies. The committed
# copies under apps/frame/extensions remain authoritative; this is a dev tool.
[ -n "${OPEN_ANVIL_SRC:-}" ] && copy "$OPEN_ANVIL_SRC" open-anvil || echo "SKIP open-anvil (set OPEN_ANVIL_SRC to refresh)"
[ -n "${TTY_BRIDGE_SRC:-}" ] && copy "$TTY_BRIDGE_SRC" floyd-tty-bridge || echo "SKIP floyd-tty-bridge (set TTY_BRIDGE_SRC to refresh)"
