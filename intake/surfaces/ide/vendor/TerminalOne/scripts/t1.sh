#!/bin/bash
#
# t1 — open TerminalOne. Ensures the always-on service is running, waits for it to
# be healthy, then opens the UI as a chrome-less app window (falls back to the
# default browser). This is the volume-resident implementation; install-service.sh
# generates a self-contained `t1` binary on the internal disk that delegates here,
# plus ~/Applications/TerminalOne.app. Run install once, then use `t1` or Spotlight.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PORT="${PORT:-11001}"
APP_DIR="${TERMINALONE_APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd -P)}"
LOG_DIR="${TERMINALONE_LOG_DIR:-$HOME/Library/Logs/TerminalOne}"
URL="${TERMINALONE_URL:-http://localhost:$PORT}"
HEALTH_URL="${TERMINALONE_HEALTH_URL:-$URL/health}"
LABEL="com.floyd.terminalone"
DOMAIN="gui/$(id -u)"

show_error() {
  local msg="$1"
  printf 't1: %s\n' "$msg" >&2
  if [ ! -t 2 ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "display dialog \"$msg\" with title \"TerminalOne\" buttons {\"OK\"} default button \"OK\" with icon caution" >/dev/null 2>&1 || true
  fi
}

wait_for_health() {
  local tries="${1:-32}"
  for _ in $(seq 1 "$tries"); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

start_direct_backend() {
  mkdir -p "$LOG_DIR"
  nohup env PORT="$PORT" node "$APP_DIR/src/server.js" >>"$LOG_DIR/local-launch.out.log" 2>>"$LOG_DIR/local-launch.err.log" &
}

if ! wait_for_health 1; then
  # Nudge the service (no-op if it isn't installed / already running).
  launchctl kickstart "$DOMAIN/$LABEL" 2>/dev/null || true

  if ! wait_for_health 16; then
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -vq '[Nn]ode'; then
      show_error "Port $PORT is already in use by another process. Free the port or change TerminalOne's port."
      exit 1
    fi

    if ! command -v node >/dev/null 2>&1; then
      show_error "Node.js is not installed or not on PATH."
      exit 1
    fi

    if [ ! -f "$APP_DIR/src/server.js" ]; then
      show_error "TerminalOne files are missing at $APP_DIR."
      exit 1
    fi

    start_direct_backend

    if ! wait_for_health 32; then
      show_error "TerminalOne failed to start. Logs: $LOG_DIR/local-launch.err.log"
      exit 1
    fi
  fi
fi

if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL"
elif [ -d "/Applications/Google Chrome Beta.app" ]; then
  open -na "Google Chrome Beta" --args --app="$URL"
else
  open "$URL"
fi
echo "TerminalOne -> $URL"
