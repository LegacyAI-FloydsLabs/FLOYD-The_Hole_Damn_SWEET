#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ALT_ROOT="$TMP/alt-checkout"
FAKEBIN="$TMP/fakebin"
HOME_DIR="$TMP/home"
APP_PARENT="$TMP/apps"
BIN_DIR="$TMP/bin"
mkdir -p "$ALT_ROOT/scripts" "$ALT_ROOT/src" "$ALT_ROOT/public" "$FAKEBIN" "$HOME_DIR"

cp "$ROOT/scripts/install-service.sh" "$ALT_ROOT/scripts/install-service.sh"
cp "$ROOT/scripts/t1.sh" "$ALT_ROOT/scripts/t1.sh"
cp "$ROOT/src/server.js" "$ALT_ROOT/src/server.js"
cp "$ROOT/public/icon-512.png" "$ALT_ROOT/public/icon-512.png"
chmod +x "$ALT_ROOT/scripts/install-service.sh" "$ALT_ROOT/scripts/t1.sh"

cat > "$FAKEBIN/node" <<'EOF'
#!/bin/bash
exit 0
EOF

cat > "$FAKEBIN/launchctl" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "print" ]; then
  exit 1
fi
exit 0
EOF

chmod +x "$FAKEBIN/node" "$FAKEBIN/launchctl"

HOME="$HOME_DIR" \
PATH="$FAKEBIN:/usr/bin:/bin:/usr/sbin:/sbin" \
TERMINALONE_APPLICATIONS_DIR="$APP_PARENT" \
TERMINALONE_BIN_DIR="$BIN_DIR" \
bash "$ALT_ROOT/scripts/install-service.sh" >/tmp/t1-install-portability.log

PLIST_PATH="$HOME_DIR/Library/LaunchAgents/com.floyd.terminalone.plist"
T1_PATH="$BIN_DIR/t1"
APP_EXEC="$APP_PARENT/TerminalOne.app/Contents/MacOS/TerminalOne"

[ -f "$PLIST_PATH" ]
[ -f "$T1_PATH" ]
[ -f "$APP_EXEC" ]

grep -q "$ALT_ROOT/src/server.js" "$PLIST_PATH"
grep -q "$ALT_ROOT/scripts/t1.sh" "$T1_PATH"
grep -q "$BIN_DIR/t1" "$APP_EXEC"

if grep -q '/Volumes/SanDisk1Tb/TerminalOne' "$PLIST_PATH" "$T1_PATH" "$APP_EXEC"; then
  echo "generated artifacts still reference the original machine path"
  exit 1
fi
