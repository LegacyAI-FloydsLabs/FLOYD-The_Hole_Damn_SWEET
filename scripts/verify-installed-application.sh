#!/bin/sh
# Cloud-safe smoke verification for an installed FLOYD Desktop Suite package.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
APP=${FLOYD_APP:-/Applications/FLOYD Desktop Suite.app}
WS="$APP/Contents/Resources/workstation"
NODE="$APP/Contents/Resources/node/bin/node"
ENGINE="$APP/Contents/Resources/engine/opencode"
RUNTIME=$(mktemp -d /tmp/floyd-installed-runtime.XXXXXX)
TEST_HOME="$RUNTIME/home"
LOG_DIR="$TEST_HOME/Library/Logs/Floyd"
TEST_KEYCHAIN="$TEST_HOME/Library/Keychains/floyd-clean-install.keychain-db"

cleanup() {
  launchctl bootout "gui/$(id -u)/com.floyd.frame" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/com.floyd.core" 2>/dev/null || true
  HOME="$TEST_HOME" /usr/bin/security delete-keychain "$TEST_KEYCHAIN" >/dev/null 2>&1 || true
  rm -rf "$RUNTIME" 2>/dev/null || true
}
trap cleanup EXIT

[ -x "$NODE" ] || { echo "FAIL: bundled node missing" >&2; exit 1; }
[ -x "$ENGINE" ] || { echo "FAIL: bundled OpenCode missing" >&2; exit 1; }
[ -f "$WS/intake/surfaces/desktop/dist-server/index.js" ] || { echo "FAIL: desktop server bundle missing" >&2; exit 1; }
[ -f "$WS/intake/surfaces/desktop/dist/index.html" ] || { echo "FAIL: desktop web bundle missing" >&2; exit 1; }
[ -f "$WS/intake/surfaces/ide/dist/index.html" ] || { echo "FAIL: IDE web bundle missing" >&2; exit 1; }

EXPECTED_ENGINE_SHA=$(python3 -c "import json;print(json.load(open('$WS/upstream.lock'))['opencode']['sha256'])")
EXPECTED_ENGINE_VERSION=$(python3 -c "import json;print(json.load(open('$WS/upstream.lock'))['opencode']['version'])")
ACTUAL_ENGINE_SHA=$(shasum -a 256 "$ENGINE" | cut -d' ' -f1)
[ "$ACTUAL_ENGINE_SHA" = "$EXPECTED_ENGINE_SHA" ] || { echo "FAIL: installed OpenCode sha mismatch" >&2; exit 1; }
ACTUAL_ENGINE_VERSION=$("$ENGINE" --version 2>/dev/null | sed -n '1p' | tr -d '[:space:]')
[ "$ACTUAL_ENGINE_VERSION" = "$EXPECTED_ENGINE_VERSION" ] || {
  echo "FAIL: installed OpenCode version mismatch ($ACTUAL_ENGINE_VERSION != $EXPECTED_ENGINE_VERSION)" >&2
  exit 1
}

PROFILE_DIR="$RUNTIME/secrets/proxy-app-profiles"
mkdir -p \
  "$TEST_HOME/Library/LaunchAgents" \
  "$TEST_HOME/Library/Preferences" \
  "$LOG_DIR" \
  "$PROFILE_DIR" \
  "$(dirname "$TEST_KEYCHAIN")"
chmod 700 "$RUNTIME/secrets" "$PROFILE_DIR"

# Frame's Vault deliberately requires the macOS Keychain. A temporary HOME
# does not have a default Keychain, so provision the same unlocked login
# context that a real clean Mac user receives during account creation.
KEYCHAIN_PASSWORD=$(openssl rand -hex 16)
HOME="$TEST_HOME" /usr/bin/security create-keychain -p "$KEYCHAIN_PASSWORD" "$TEST_KEYCHAIN"
HOME="$TEST_HOME" /usr/bin/security set-keychain-settings -lut 21600 "$TEST_KEYCHAIN"
HOME="$TEST_HOME" /usr/bin/security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$TEST_KEYCHAIN"
HOME="$TEST_HOME" /usr/bin/security list-keychains -d user -s "$TEST_KEYCHAIN"
HOME="$TEST_HOME" /usr/bin/security default-keychain -d user -s "$TEST_KEYCHAIN"
HOME="$TEST_HOME" /usr/bin/security default-keychain -d user >/dev/null
unset KEYCHAIN_PASSWORD

cat > "$PROFILE_DIR/core.json" <<'PROFILE'
{"app":"core","proxyToken":"fv_core_0123456789abcdef0123456789abcdef","proxyUrl":"http://127.0.0.1:41999"}
PROFILE
chmod 600 "$PROFILE_DIR/core.json"
HOME="$TEST_HOME" FLOYD_RUNTIME_ROOT="$RUNTIME" "$APP/Contents/MacOS/FLOYD Desktop Suite"

wait_http() {
  url=$1
  i=0
  while [ "$i" -lt 60 ]; do
    curl -fsS -o /dev/null "$url" && return 0
    i=$((i + 1))
    sleep 0.5
  done
  echo "FAIL: $url did not become healthy" >&2
  for log in "$LOG_DIR"/*.log; do
    [ -f "$log" ] || continue
    echo "--- $log" >&2
    sed -n '1,240p' "$log" >&2
  done
  launchctl print "gui/$(id -u)/com.floyd.frame" >&2 || true
  HOME="$TEST_HOME" /usr/bin/security default-keychain -d user >&2 || true
  return 1
}

wait_http http://127.0.0.1:13030/
i=0
while [ "$i" -lt 60 ]; do
  [ -s "$RUNTIME/core/gateway.token" ] && break
  sleep 0.5
  i=$((i + 1))
done
[ -s "$RUNTIME/core/gateway.token" ] || { echo "FAIL: installed Core did not create its gateway token" >&2; exit 1; }
CORE_TOKEN=$(tr -d '[:space:]' < "$RUNTIME/core/gateway.token")
i=0
CORE_READY=0
while [ "$i" -lt 60 ]; do
  CORE_HEALTH=$(curl -fsS -H "Authorization: Bearer $CORE_TOKEN" http://127.0.0.1:41414/api/health 2>/dev/null || true)
  if printf '%s' "$CORE_HEALTH" | python3 -c 'import json,sys; h=json.load(sys.stdin); assert h.get("ok") is True and h.get("engine",{}).get("ok") is True' 2>/dev/null; then
    CORE_READY=1
    break
  fi
  sleep 0.5
  i=$((i + 1))
done
[ "$CORE_READY" = 1 ] || { echo "FAIL: installed Core/OpenCode did not become healthy" >&2; exit 1; }
curl -fsS http://127.0.0.1:13030/api/registry | grep -q 'cursem-ide'
curl -fsS -X POST http://127.0.0.1:13030/api/launch/cursem-ide | grep -q '"up":true'
wait_http http://127.0.0.1:13012/
curl -fsS -X POST http://127.0.0.1:13030/api/launch/floyd-desktop | grep -q '"up":true'
wait_http http://127.0.0.1:13010/

echo "FLOYD_INSTALLED_SMOKE PASS launcher=installed-app core=41414 frame=13030 ide=13012 desktop=13010 opencode=$ACTUAL_ENGINE_VERSION sha256=$ACTUAL_ENGINE_SHA"
