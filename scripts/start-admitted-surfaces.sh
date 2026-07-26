#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RUNTIME_ROOT=${FLOYD_RUNTIME_ROOT:-/Volumes/Storage/FLOYD_RUNTIME}
STATE_DIR="$RUNTIME_ROOT/surfaces"
AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/Floyd"
DOMAIN="gui/$(id -u)"
mkdir -p "$STATE_DIR" "$AGENT_DIR" "$LOG_DIR"
chmod 700 "$STATE_DIR"

listener_pid() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | sed -n '1p'
}

process_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
}

wait_for_health() {
  url=$1
  attempts=0
  until curl -fsS --max-time 2 "$url" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      printf 'health timeout: %s\n' "$url" >&2
      return 1
    fi
    sleep 0.25
  done
}

install_agent() {
  id=$1
  port=$2
  health=$3
  repo="$ROOT/intake/surfaces/$id"
  label="com.floyd.surface.$id"
  source_plist="$ROOT/ops/launchd/$label.plist"
  target_plist="$AGENT_DIR/$label.plist"
  commit=$(git -C "$repo" rev-parse HEAD)

  pid=$(listener_pid "$port" || true)
  if [ -n "$pid" ] && [ "$(process_cwd "$pid" || true)" != "$repo" ]; then
    printf '%s port %s belongs to non-admitted process %s\n' "$id" "$port" "$pid" >&2
    return 1
  fi

  install -m 600 "$source_plist" "$target_plist"
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:FLOYD_SURFACE_COMMIT $commit" "$target_plist"
  launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
  attempts=0
  while launchctl print "$DOMAIN/$label" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 20 ] || {
      printf 'launchd did not release prior service: %s\n' "$label" >&2
      return 1
    }
    sleep 0.1
  done
  attempts=0
  until launchctl bootstrap "$DOMAIN" "$target_plist" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 10 ] || {
      printf 'launchd bootstrap failed: %s\n' "$label" >&2
      return 1
    }
    sleep 0.2
  done
  wait_for_health "$health"

  pid=$(listener_pid "$port")
  cwd=$(process_cwd "$pid")
  [ "$cwd" = "$repo" ] || {
    printf '%s listener provenance mismatch: %s\n' "$id" "$cwd" >&2
    return 1
  }
  node --input-type=module - "$health" "$id" "$repo" "$commit" <<'NODE'
const [url, surfaceId, sourceRoot, sourceCommit] = process.argv.slice(2);
const response = await fetch(url);
const body = await response.json();
if (!response.ok || body?.identity?.surface_id !== surfaceId
  || body?.identity?.source_root !== sourceRoot || body?.identity?.source_commit !== sourceCommit) {
  throw new Error(`${surfaceId} admission identity mismatch: ${JSON.stringify(body?.identity ?? null)}`);
}
NODE
  printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$port" "$pid" "$cwd" "$commit"
}

install_agent desktop 13010 http://127.0.0.1:13010/api/health
install_agent ide 13012 http://127.0.0.1:13012/api/health
install_agent pty 13013 http://127.0.0.1:13013/health
install_agent launcher 13014 http://127.0.0.1:13014/health

# Recheck after every bootstrap command has returned. This prevents the old
# detached-shell false positive where a service passed health and then died.
sleep 1
for port in 13010 13012 13013 13014; do
  [ -n "$(listener_pid "$port" || true)" ] || {
    printf 'admitted listener disappeared after bootstrap: %s\n' "$port" >&2
    exit 1
  }
done
printf 'ADMITTED_SURFACES LIVE AND LAUNCHD-OWNED\n'
