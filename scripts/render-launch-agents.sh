#!/bin/sh
# render-launch-agents.sh — generate machine-correct LaunchAgent plists.
#
# Renders com.floyd.frame (and optionally chrono + surface agents) for THIS
# machine: this clone's path, this user's HOME, whatever node is installed.
# Nothing is hardcoded to a particular volume or username.
#
#   ./scripts/render-launch-agents.sh            # render + install frame agent
#   ./scripts/render-launch-agents.sh --all      # also chrono + admitted surfaces
#   ./scripts/render-launch-agents.sh --dry-run  # print paths, install nothing
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
RUNTIME_ROOT=${FLOYD_RUNTIME_ROOT:-}
if [ -z "$RUNTIME_ROOT" ]; then
  if [ -d /Volumes/Storage/FLOYD_RUNTIME ]; then RUNTIME_ROOT=/Volumes/Storage/FLOYD_RUNTIME
  else RUNTIME_ROOT="$HOME/.floyd"; fi
fi
if [ -x /opt/homebrew/bin/node ]; then NODE_BIN=/opt/homebrew/bin/node
elif command -v node >/dev/null 2>&1; then NODE_BIN=$(command -v node)
else echo "no node found — install node first" >&2; exit 1; fi
PY_BIN=$(command -v python3 || echo /usr/bin/python3)
AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/Floyd"
DRY=0; ALL=0
for a in "$@"; do case "$a" in --dry-run) DRY=1;; --all) ALL=1;; esac; done

emit() { # label out_path
  label=$1; shift
  target="$AGENT_DIR/$label.plist"
  if [ "$DRY" = 1 ]; then echo "would install $target"; cat > /dev/null; return; fi
  mkdir -p "$AGENT_DIR" "$LOG_DIR"
  cat > "$target"
  chmod 600 "$target"
  echo "installed $target"
}

frame_plist() {
cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.floyd.frame</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string>
    <string>$ROOT/apps/frame/server/frame-server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT/apps/frame</string>
  <key>EnvironmentVariables</key><dict>
    <key>FRAME_PORT</key><string>13030</string>
    <key>HOME</key><string>$HOME</string>
    <key>FLOYD_RUNTIME_ROOT</key><string>$RUNTIME_ROOT</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/frame.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/frame.err.log</string>
</dict></plist>
EOF
}

chrono_plist() {
cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.floyd.chrono</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME</string>
    <key>FLOYD_WORKSTATION_ROOT</key><string>$ROOT</string>
  </dict>
  <key>ProgramArguments</key><array>
    <string>$PY_BIN</string>
    <string>$ROOT/ops/chrono/chrono_daemon.py</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT/ops/chrono</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/chrono.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/chrono.err.log</string>
</dict></plist>
EOF
}

surface_plist() { # id port extra_env_xml program_json
  sid=$1; sport=$2; extra=$3
cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.floyd.surface.$sid</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>dist-server/index.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT/intake/surfaces/$sid</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOST</key><string>127.0.0.1</string><key>PORT</key><string>$sport</string>$extra
    <key>FLOYD_CORE_URL</key><string>http://127.0.0.1:41414</string>
    <key>FLOYD_RUNTIME_ROOT</key><string>$RUNTIME_ROOT</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/$sid.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$sid.log</string>
</dict></plist>
EOF
}

echo "repo:    $ROOT"
echo "runtime: $RUNTIME_ROOT"
echo "node:    $NODE_BIN"
frame_plist  | emit com.floyd.frame
if [ "$ALL" = 1 ]; then
  chrono_plist | emit com.floyd.chrono
  surface_plist desktop 13010 "<key>MCP_WS_PORT</key><string>13011</string>" | emit com.floyd.surface.desktop
  surface_plist ide 13012 "" | emit com.floyd.surface.ide
  surface_plist pty 13013 "" | emit com.floyd.surface.pty
  surface_plist launcher 13014 "" | emit com.floyd.surface.launcher
fi
echo "done. load with: launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.floyd.frame.plist"
