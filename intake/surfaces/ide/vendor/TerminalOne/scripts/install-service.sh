#!/bin/bash
#
# TerminalOne — install the always-on macOS LaunchAgent (launchd).
#
# EFFECT RADIUS (what this changes on your machine):
#   - Writes ~/Library/LaunchAgents/com.floyd.terminalone.plist
#   - Registers a per-user LaunchAgent that runs `node src/server.js` on PORT 11001
#   - RunAtLoad (starts at login) + KeepAlive (auto-restart on crash)
#   - KeepAlive is gated on PathState: it only runs while
#     the installed checkout's `src/server.js` exists (i.e. the app volume is
#     mounted), and auto-starts when the volume re-appears.
#   - Logs to ~/Library/Logs/com.floyd.terminalone.{out,err}.log (INTERNAL disk;
#     launchd cannot reliably create log files on the external volume -> EX_CONFIG).
#   - Installs a self-contained `t1` binary on the INTERNAL disk (first writable of
#     ~/.local/bin, /usr/local/bin, ~/bin) so `t1` works from any shell and does NOT
#     dangle when the external volume unmounts (it mount-checks and errors clearly).
#   - Creates ~/Applications/TerminalOne.app (with brand icon, quarantine cleared) so
#     it launches with no terminal: Spotlight (Cmd-Space), Launchpad, and the Dock.
# Fully reversible: scripts/uninstall-service.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
LABEL="com.floyd.terminalone"
APP_DIR="${TERMINALONE_APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd -P)}"
PORT="${PORT:-11001}"
NODE="${TERMINALONE_NODE:-$(command -v node || true)}"
PLIST_DIR="${TERMINALONE_PLIST_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="${TERMINALONE_SYSTEM_LOG_DIR:-$HOME/Library/Logs}"
DOMAIN="gui/$(id -u)"
APP_PARENT_OVERRIDE="${TERMINALONE_APPLICATIONS_DIR:-}"
T1_BIN_DIR_OVERRIDE="${TERMINALONE_BIN_DIR:-}"

[ -n "$NODE" ] || { echo "ERROR: node not found in PATH"; exit 1; }
[ -f "$APP_DIR/src/server.js" ] || { echo "ERROR: $APP_DIR/src/server.js not found (is the volume mounted?)"; exit 1; }
mkdir -p "$PLIST_DIR" "$LOG_DIR"

# NOTE: no WorkingDirectory key — the server resolves all paths via __dirname, and a
# chdir into the external volume from the launchd context can itself trigger EX_CONFIG.
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$APP_DIR/src/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>PathState</key>
    <dict>
      <key>$APP_DIR/src/server.js</key><true/>
    </dict>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/$LABEL.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$LABEL.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLISTEOF

# (Re)load cleanly and IDEMPOTENTLY. bootout is async and KeepAlive/PathState can
# respawn the job mid-teardown, so bootstrap can race it (Input/output error 5).
# Wait for the label to actually disappear (up to ~5s). If it's still present after
# the wait, the service is truly still loaded and we reload via kickstart in place.
# If it disappeared, bootstrap should succeed — any failure is a real error.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
LABEL_STILL_PRESENT=false
for _ in $(seq 1 20); do
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    LABEL_STILL_PRESENT=true
    sleep 0.25
  else
    LABEL_STILL_PRESENT=false
    break
  fi
done
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
if $LABEL_STILL_PRESENT; then
  # Label survived bootout + 5s wait — service is legitimately still loaded.
  # bootstrap would fail because the label exists; reload via kickstart instead.
  echo "  note  : service already loaded; reloading in place."
  launchctl kickstart -k "$DOMAIN/$LABEL" || {
    echo "ERROR: failed to kickstart existing service." >&2
    exit 1
  }
else
  # Label gone after bootout — fresh bootstrap MUST succeed.
  if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
    echo "ERROR: launchctl bootstrap failed — service was not installed." >&2
    exit 1
  fi
  launchctl kickstart -k "$DOMAIN/$LABEL" || true
fi

# --- Install `t1` as a REAL self-contained binary on the INTERNAL disk.
# Not a symlink into the external volume: a symlink would dangle ("no such file")
# the moment the app volume unmounts. This generated stub lives on the internal disk,
# bakes in the app path, checks the mount, and fails LOUDLY (stderr + GUI dialog)
# instead of cryptically when the volume is gone.
chmod +x "$APP_DIR/scripts/t1.sh" 2>/dev/null || true
# Pick a bin dir on the INTERNAL disk. macOS: / is a sealed snapshot but writable
# paths live on the Data volume (same physical internal container); we match that
# device and reject any /Volumes/* external mount so `t1` can't live on a disk that
# unmounts. Prefer dirs already on PATH.
INTERNAL_DEV="$(df /System/Volumes/Data 2>/dev/null | tail -1 | awk '{print $1}')"
[ -n "$INTERNAL_DEV" ] || INTERNAL_DEV="$(df / | tail -1 | awk '{print $1}')"
is_internal() { case "$1" in /Volumes/*) return 1;; esac; [ "$(df "$1" 2>/dev/null | tail -1 | awk '{print $1}')" = "$INTERNAL_DEV" ]; }
T1_BIN_DIR=""
if [ -n "$T1_BIN_DIR_OVERRIDE" ]; then
  mkdir -p "$T1_BIN_DIR_OVERRIDE"
  T1_BIN_DIR="$T1_BIN_DIR_OVERRIDE"
else
  for d in "$HOME/bin" /usr/local/bin "$HOME/.local/bin"; do
    if [ -d "$d" ] && [ -w "$d" ] && is_internal "$d"; then T1_BIN_DIR="$d"; break; fi
  done
  if [ -z "$T1_BIN_DIR" ]; then
    # Nothing writable+internal+existing; create ~/bin on the internal disk.
    if mkdir -p "$HOME/bin" 2>/dev/null && is_internal "$HOME/bin"; then
      T1_BIN_DIR="$HOME/bin"
    else
      T1_BIN_DIR="$HOME/.local/bin"; mkdir -p "$T1_BIN_DIR"
      echo "  WARN  : no internal-disk bin dir found; t1 placed on $T1_BIN_DIR (may be external)."
    fi
  fi
fi
T1_LINK="$T1_BIN_DIR/t1"
cat > "$T1_LINK" <<T1EOF
#!/bin/bash
# TerminalOne launcher — generated by install-service.sh. Self-contained; lives on
# the internal disk so it survives "$APP_DIR" unmounting. Regenerate via reinstall.
set -euo pipefail
T1_APP="$APP_DIR/scripts/t1.sh"
if [ ! -f "\$T1_APP" ]; then
  MSG="TerminalOne is unavailable: its volume is not mounted (expected at $APP_DIR). Reconnect the drive, then try again."
  printf '\\033[31mt1: %s\\033[0m\\n' "\$MSG" >&2
  # If launched without a terminal (Finder/Spotlight/Dock), surface a GUI dialog too.
  if [ ! -t 2 ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "display dialog \"\$MSG\" with title \"TerminalOne\" buttons {\"OK\"} default button \"OK\" with icon caution" >/dev/null 2>&1 || true
  fi
  exit 1
fi
exec "\$T1_APP" "\$@"
T1EOF
chmod +x "$T1_LINK"

# --- Make TerminalOne launchable from anywhere WITHOUT a terminal:
# a tiny .app bundle -> shows in Spotlight, Launchpad, and Dock. Prefer /Applications
# (canonically Spotlight-indexed); fall back to ~/Applications if it's not writable.
if [ -n "$APP_PARENT_OVERRIDE" ]; then
  APP_PARENT="$APP_PARENT_OVERRIDE"
  mkdir -p "$APP_PARENT"
elif [ -w /Applications ]; then
  APP_PARENT="/Applications"
else
  APP_PARENT="$HOME/Applications"
  mkdir -p "$APP_PARENT"
fi
APP_BUNDLE="$APP_PARENT/TerminalOne.app"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
cat > "$APP_BUNDLE/Contents/Info.plist" <<APPEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>TerminalOne</string>
  <key>CFBundleDisplayName</key><string>TerminalOne</string>
  <key>CFBundleIdentifier</key><string>com.floyd.terminalone.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>TerminalOne</string>
  <key>CFBundleIconFile</key><string>TerminalOne</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
APPEOF
cat > "$APP_BUNDLE/Contents/MacOS/TerminalOne" <<APPEOF
#!/bin/bash
# Delegates to the internal-disk t1 binary, which handles the mount-check + GUI error.
exec "$T1_LINK"
APPEOF
chmod +x "$APP_BUNDLE/Contents/MacOS/TerminalOne"
# Build the .icns from the brand icon so it shows in Spotlight/Launchpad/Dock.
RES_DIR="$APP_BUNDLE/Contents/Resources"
mkdir -p "$RES_DIR"
ICON_SRC="$APP_DIR/public/icon-512.png"
if [ -f "$ICON_SRC" ] && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/TerminalOne.iconset"
  mkdir -p "$ICONSET"
  for sz in 16 32 64 128 256 512; do
    sips -z $sz $sz "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null 2>&1 || true
    dbl=$((sz*2))
    sips -z $dbl $dbl "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$RES_DIR/TerminalOne.icns" 2>/dev/null || cp "$ICON_SRC" "$RES_DIR/TerminalOne.png"
  rm -rf "$(dirname "$ICONSET")"
fi
# Clear any quarantine flag so the locally-built bundle never triggers a Gatekeeper
# prompt on first Finder/Spotlight launch. Safe no-op if no flag is present.
xattr -dr com.apple.quarantine "$APP_BUNDLE" 2>/dev/null || true
# Register with Launch Services so Spotlight/Launchpad index it promptly.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_BUNDLE" 2>/dev/null || true
# Ensure the chosen bin dir is actually on PATH. If not, add a marked line to the
# user's shell rc (idempotent — only once). Covers zsh (default) and bash.
T1_PATH_ADDED=""
case ":$PATH:" in
  *":$T1_BIN_DIR:"*) : ;;  # already on PATH this session
  *)
    MARK="# added by TerminalOne install-service.sh"
    LINE="export PATH=\"$T1_BIN_DIR:\$PATH\"  $MARK"
    for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
      if [ ! -e "$rc" ]; then
        if [ "$rc" = "$HOME/.zshrc" ]; then touch "$rc"; else continue; fi
      fi
      if ! grep -qF "$MARK" "$rc" 2>/dev/null; then
        printf '\n%s\n' "$LINE" >> "$rc" && T1_PATH_ADDED="$rc"
      fi
    done
    ;;
esac

echo "Installed $LABEL"
echo "  plist : $PLIST"
echo "  node  : $NODE"
echo "  logs  : $LOG_DIR/$LABEL.{out,err}.log and $LOG_DIR/TerminalOne/local-launch.err.log"
echo "  url   : http://localhost:$PORT"
echo "  t1    : ${T1_LINK:-(failed to link)}"
echo "  app   : $APP_BUNDLE  (Spotlight: Cmd-Space -> TerminalOne)"
echo "  app   : opens the UI only after health is confirmed; falls back to direct local startup if launchd is unavailable."
echo "Manage: launchctl print $DOMAIN/$LABEL   |   stop: scripts/uninstall-service.sh"
if [ -n "$T1_PATH_ADDED" ]; then
  echo "  PATH  : added $T1_BIN_DIR to $T1_PATH_ADDED — run 'source $T1_PATH_ADDED' or open a new shell, then 't1'."
else
  echo "  PATH  : $T1_BIN_DIR already on PATH — run 't1' now."
fi
