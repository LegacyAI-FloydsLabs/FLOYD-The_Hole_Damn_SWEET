#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN" "$TMP/logs" "$TMP/state"

cat > "$FAKEBIN/open" <<'EOF'
#!/bin/bash
echo "OPEN:$*" >> "$STATE_FILE"
EOF

cat > "$FAKEBIN/curl" <<'EOF'
#!/bin/bash
if [ -f "$HEALTHY_FILE" ]; then
  exit 0
fi
exit 7
EOF

cat > "$FAKEBIN/launchctl" <<'EOF'
#!/bin/bash
echo "LAUNCHCTL:$*" >> "$STATE_FILE"
exit 0
EOF

cat > "$FAKEBIN/node" <<'EOF'
#!/bin/bash
echo "NODE:$*" >> "$STATE_FILE"
touch "$HEALTHY_FILE"
sleep 1
EOF

cat > "$FAKEBIN/lsof" <<'EOF'
#!/bin/bash
exit 1
EOF

cat > "$FAKEBIN/osascript" <<'EOF'
#!/bin/bash
echo "OSASCRIPT:$*" >> "$STATE_FILE"
EOF

chmod +x "$FAKEBIN/"*

STATE_FILE="$TMP/state/events.log"
HEALTHY_FILE="$TMP/state/healthy"

STATE_FILE="$STATE_FILE" \
HEALTHY_FILE="$HEALTHY_FILE" \
PATH="$FAKEBIN:/usr/bin:/bin:/usr/sbin:/sbin" \
TERMINALONE_APP_DIR="$ROOT" \
TERMINALONE_LOG_DIR="$TMP/logs" \
PORT=11001 \
bash "$ROOT/scripts/t1.sh"

grep -q 'LAUNCHCTL:kickstart' "$TMP/state/events.log"
grep -q 'NODE:' "$TMP/state/events.log"
grep -q 'OPEN:' "$TMP/state/events.log"

cat > "$FAKEBIN/lsof" <<'EOF'
#!/bin/bash
echo "python3 99999 douglastalley  12u  IPv4 0x0  TCP *:11001 (LISTEN)"
EOF
chmod +x "$FAKEBIN/lsof"
rm -f "$HEALTHY_FILE"

if STATE_FILE="$TMP/state/port.log" \
   HEALTHY_FILE="$TMP/state/healthy" \
   PATH="$FAKEBIN:/usr/bin:/bin:/usr/sbin:/sbin" \
   TERMINALONE_APP_DIR="$ROOT" \
   TERMINALONE_LOG_DIR="$TMP/logs" \
   PORT=11001 \
   bash "$ROOT/scripts/t1.sh"; then
  echo "expected port collision failure"
  exit 1
fi

grep -q 'LAUNCHCTL:kickstart' "$TMP/state/port.log"
grep -q 'OSASCRIPT:' "$TMP/state/port.log"
if grep -q 'OPEN:' "$TMP/state/port.log"; then
  echo "port collision should not open the UI"
  exit 1
fi

cat > "$FAKEBIN/lsof" <<'EOF'
#!/bin/bash
exit 1
EOF
chmod +x "$FAKEBIN/lsof"

ALT_ROOT="$TMP/alt-checkout"
mkdir -p "$ALT_ROOT/scripts" "$ALT_ROOT/src"
cp "$ROOT/scripts/t1.sh" "$ALT_ROOT/scripts/t1.sh"
touch "$ALT_ROOT/src/server.js"

ALT_HEALTHY_FILE="$TMP/state/derived-healthy"
STATE_FILE="$TMP/state/derived.log" \
HEALTHY_FILE="$ALT_HEALTHY_FILE" \
PATH="$FAKEBIN:/usr/bin:/bin:/usr/sbin:/sbin" \
TERMINALONE_LOG_DIR="$TMP/logs" \
PORT=11001 \
bash "$ALT_ROOT/scripts/t1.sh"

grep -q "NODE:.*$ALT_ROOT/src/server.js" "$TMP/state/derived.log"
grep -q 'OPEN:' "$TMP/state/derived.log"
