#!/bin/sh
# Cloud-safe smoke verification for an installed FLOYD Desktop Suite package.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
APP=${FLOYD_APP:-/Applications/FLOYD Desktop Suite.app}
WS="$APP/Contents/Resources/workstation"
NODE="$APP/Contents/Resources/node/bin/node"
ENGINE="$APP/Contents/Resources/engine/opencode"
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
IDE_ROOT="$WS/intake/surfaces/ide"
NODE_DIR=$(dirname "$NODE")
SERVICE_PATH="$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin"
RUNTIME=$(mktemp -d /tmp/floyd-installed-runtime.XXXXXX)
TEST_HOME="$RUNTIME/home"
LOG_DIR="$TEST_HOME/Library/Logs/Floyd"
TEST_KEYCHAIN="$TEST_HOME/Library/Keychains/floyd-clean-install.keychain-db"
SERVICES_STARTED=0

cleanup() {
  if [ "$SERVICES_STARTED" = 1 ]; then
    curl -fsS -X POST http://127.0.0.1:13030/api/action/close-chrome >/dev/null 2>&1 || true
    launchctl bootout "gui/$(id -u)/com.floyd.frame" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)/com.floyd.core" 2>/dev/null || true
  fi
  HOME="$TEST_HOME" /usr/bin/security delete-keychain "$TEST_KEYCHAIN" >/dev/null 2>&1 || true
  rm -rf "$RUNTIME" 2>/dev/null || true
}
trap cleanup EXIT

for label in com.floyd.frame com.floyd.core; do
  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    echo "FAIL: clean-install verification refuses to replace running service $label" >&2
    exit 1
  fi
done

[ -x "$NODE" ] || { echo "FAIL: bundled node missing" >&2; exit 1; }
[ -x "$ENGINE" ] || { echo "FAIL: bundled OpenCode missing" >&2; exit 1; }
[ -x "$CHROME_BIN" ] || { echo "FAIL: Google Chrome required by the internal browser is missing" >&2; exit 1; }
[ -f "$WS/intake/surfaces/desktop/dist-server/index.js" ] || { echo "FAIL: desktop server bundle missing" >&2; exit 1; }
[ -f "$WS/intake/surfaces/desktop/dist/index.html" ] || { echo "FAIL: desktop web bundle missing" >&2; exit 1; }
[ -f "$WS/intake/surfaces/ide/dist/index.html" ] || { echo "FAIL: IDE web bundle missing" >&2; exit 1; }
for addon in addon-fit addon-webgl addon-canvas addon-search addon-unicode11; do
  [ -f "$WS/apps/frame/extensions/floyd-tty-bridge/node_modules/@xterm/$addon/lib/$addon.js" ] || {
    echo "FAIL: TTY Bridge runtime dependency missing: $addon" >&2
    exit 1
  }
done
for launcher in \
  bash-language-server \
  pyright \
  pyright-langserver \
  typescript-language-server \
  vscode-css-language-server \
  vscode-html-language-server \
  vscode-json-language-server; do
  [ -x "$IDE_ROOT/node_modules/.bin/$launcher" ] || {
    echo "FAIL: IDE runtime launcher missing: $launcher" >&2
    exit 1
  }
done
[ -f "$IDE_ROOT/node_modules/typescript/lib/tsserver.js" ] || {
  echo "FAIL: TypeScript server runtime missing" >&2
  exit 1
}

EXPECTED_SOURCE_COMMIT=$(git -C "$ROOT" rev-parse HEAD)
INSTALLED_SOURCE_COMMIT=$(python3 -c "import json;print(json.load(open('$WS/release.json'))['source_commit'])")
[ "$INSTALLED_SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT" ] || {
  echo "FAIL: installed release identity mismatch ($INSTALLED_SOURCE_COMMIT != $EXPECTED_SOURCE_COMMIT)" >&2
  exit 1
}

EXPECTED_NODE_SHA=$(python3 -c "import json;print(json.load(open('$WS/upstream.lock'))['node']['sha256'])")
EXPECTED_NODE_VERSION="v$(python3 -c "import json;print(json.load(open('$WS/upstream.lock'))['node']['version'])")"
ACTUAL_NODE_SHA=$(shasum -a 256 "$NODE" | cut -d' ' -f1)
[ "$ACTUAL_NODE_SHA" = "$EXPECTED_NODE_SHA" ] || { echo "FAIL: installed Node sha mismatch" >&2; exit 1; }
ACTUAL_NODE_VERSION=$("$NODE" --version 2>/dev/null | tr -d '[:space:]')
[ "$ACTUAL_NODE_VERSION" = "$EXPECTED_NODE_VERSION" ] || {
  echo "FAIL: installed Node version mismatch ($ACTUAL_NODE_VERSION != $EXPECTED_NODE_VERSION)" >&2
  exit 1
}

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

for app in ff omf launcher; do
  printf '{"app":"%s","proxyToken":"fv_%s_0123456789abcdef0123456789abcdef","proxyUrl":"http://127.0.0.1:41999"}\n' \
    "$app" "$app" > "$PROFILE_DIR/$app.json"
  chmod 600 "$PROFILE_DIR/$app.json"
done
SERVICES_STARTED=1
HOME="$TEST_HOME" FLOYD_RUNTIME_ROOT="$RUNTIME" "$APP/Contents/MacOS/FLOYD Desktop Suite"

python3 - "$TEST_HOME/Library/LaunchAgents/com.floyd.frame.plist" \
  "$TEST_HOME/Library/LaunchAgents/com.floyd.core.plist" "$SERVICE_PATH" "$NODE" <<'PY'
import plistlib
import sys

for path in sys.argv[1:3]:
    with open(path, "rb") as handle:
        environment = plistlib.load(handle)["EnvironmentVariables"]
    assert environment["PATH"] == sys.argv[3], (path, environment.get("PATH"))
    assert environment["FLOYD_AGENT_NODE"] == sys.argv[4], (path, environment.get("FLOYD_AGENT_NODE"))
PY

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
  if printf '%s' "$CORE_HEALTH" | python3 -c 'import json,sys; h=json.load(sys.stdin); assert h.get("ok") is True and h.get("engine",{}).get("ok") is True and h.get("release",{}).get("source_commit") == sys.argv[1]' "$EXPECTED_SOURCE_COMMIT" 2>/dev/null; then
    CORE_READY=1
    break
  fi
  sleep 0.5
  i=$((i + 1))
done
[ "$CORE_READY" = 1 ] || { echo "FAIL: installed Core/OpenCode did not become healthy" >&2; exit 1; }

# Frame/Vault must mint Core's real capability before Core starts. Prove that
# the installed OpenCode configuration consumed that exact live capability,
# then authenticate it against the running Vault. This prevents a dead or
# pre-seeded profile from making a healthy-but-unusable Core false-pass.
CORE_PROFILE="$PROFILE_DIR/core.json"
ENGINE_CONFIG="$RUNTIME/engines/opencode/config/opencode.json"
VAULT_CORE_TOKEN=$(python3 - "$CORE_PROFILE" "$ENGINE_CONFIG" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    profile = json.load(handle)
with open(sys.argv[2], encoding="utf-8") as handle:
    config = json.load(handle)

assert profile["app"] == "core", profile
assert profile["proxyUrl"] == "http://127.0.0.1:13031", profile
assert re.fullmatch(r"fv_core_[0-9a-f]{32,}", profile["proxyToken"]), profile
options = config["provider"]["zai-coding-plan"]["options"]
assert options["apiKey"] == profile["proxyToken"], options
assert options["baseURL"] == "http://127.0.0.1:13031/p/zai/api/coding/paas/v4", options
print(profile["proxyToken"], end="")
PY
)
VAULT_STATUS=$(curl -fsS -H "Authorization: Bearer $VAULT_CORE_TOKEN" \
  http://127.0.0.1:13031/status)
printf '%s' "$VAULT_STATUS" | python3 -c 'import json,sys; status=json.load(sys.stdin); assert status.get("ok") is True and status.get("app") == "core" and status.get("authority") == "floyd-vault-keychain", status'

for app in ff omf; do
  case "$app" in
    ff) version_pattern='^floyd version v[0-9]+\.[0-9]+\.[0-9]+$' ;;
    omf) version_pattern='^omp/[0-9]+\.[0-9]+\.[0-9]+$' ;;
  esac
  if ! HOME="$TEST_HOME" PATH="$SERVICE_PATH" FLOYD_RUNTIME_ROOT="$RUNTIME" \
    FLOYD_VAULT_APP_PROFILE="$PROFILE_DIR/$app.json" \
    "$WS/intake/surfaces/$app/launch.sh" --version >"$LOG_DIR/$app-version.log" 2>&1; then
    echo "FAIL: installed $app managed launcher could not use bundled Node" >&2
    sed -n '1,160p' "$LOG_DIR/$app-version.log" >&2
    exit 1
  fi
  if ! grep -Eq "$version_pattern" "$LOG_DIR/$app-version.log"; then
    echo "FAIL: installed $app launcher did not execute its packaged binary" >&2
    sed -n '1,160p' "$LOG_DIR/$app-version.log" >&2
    exit 1
  fi
done
if ! HOME="$TEST_HOME" PATH="$SERVICE_PATH" FLOYD_RUNTIME_ROOT="$RUNTIME" \
  FLOYD_AGENT_NODE="$NODE" FLOYD_AGENT_REAL_BIN="$WS/intake/surfaces/ff/bin/floyd-ff-real" \
  FLOYD_VAULT_APP_PROFILE="$PROFILE_DIR/launcher.json" \
  "$WS/intake/surfaces/launcher/agents/bin/floyd-agent" code-reviewer --version \
  >"$LOG_DIR/floyd-agent-version.log" 2>&1; then
  echo "FAIL: installed agent launcher could not use bundled Node" >&2
  sed -n '1,160p' "$LOG_DIR/floyd-agent-version.log" >&2
  exit 1
fi
if ! grep -Eq '^floyd version v[0-9]+\.[0-9]+\.[0-9]+$' "$LOG_DIR/floyd-agent-version.log"; then
  echo "FAIL: installed agent launcher did not execute its packaged binary" >&2
  sed -n '1,160p' "$LOG_DIR/floyd-agent-version.log" >&2
  exit 1
fi

REGISTRY=$(curl -fsS http://127.0.0.1:13030/api/registry)
printf '%s' "$REGISTRY" | python3 -c 'import json,sys; ids={app["id"] for app in json.load(sys.stdin)["apps"]}; required={"cursem-ide","floyd-desktop","harness-launcher","floyd-code-cli","ohmyfloyd"}; assert required <= ids, required-ids'
curl -fsS -X POST http://127.0.0.1:13030/api/launch/cursem-ide | grep -q '"up":true'
wait_http http://127.0.0.1:13012/
wait_http http://127.0.0.1:13013/
CURSEM="$IDE_ROOT/cli/bin/cursem"
CURSEM_NODE_PROBE="$RUNTIME/cursem-node-probe"
CURSEM_NODE_RECEIPT="$RUNTIME/cursem-node-receipt"
cat > "$CURSEM_NODE_PROBE" <<EOF
#!/bin/sh
printf '%s\n' "\$0" > "$CURSEM_NODE_RECEIPT"
exec "$NODE" "\$@"
EOF
chmod 755 "$CURSEM_NODE_PROBE"
CURSEM_VERSION=$(HOME="$TEST_HOME" FLOYD_AGENT_NODE="$CURSEM_NODE_PROBE" \
  /bin/zsh -l -c '"$1" --version' _ "$CURSEM")
[ "$CURSEM_VERSION" = 1 ] && [ "$(cat "$CURSEM_NODE_RECEIPT")" = "$CURSEM_NODE_PROBE" ] || {
  echo "FAIL: CURSEM bundled-Node smoke did not use FLOYD_AGENT_NODE" >&2
  exit 1
}
for language in typescript json html css python shell; do
  curl -fsS -X POST -H 'Content-Type: application/json' \
    --data "{\"languageId\":\"$language\"}" \
    http://127.0.0.1:13012/api/lsp/restart | grep -q '"ok":true'
  sleep 1
  LSP_HEALTH=$(curl -fsS "http://127.0.0.1:13012/api/lsp/health?language=$language")
  printf '%s' "$LSP_HEALTH" | python3 -c 'import json,sys; health=json.load(sys.stdin); assert health.get("status") == "running", health'
done
curl -fsS -X POST http://127.0.0.1:13030/api/launch/floyd-desktop | grep -q '"up":true'
wait_http http://127.0.0.1:13010/
curl -fsS -X POST http://127.0.0.1:13030/api/launch/harness-launcher | grep -q '"up":true'
wait_http http://127.0.0.1:13014/
curl -fsS -X POST http://127.0.0.1:13030/api/launch/floyd-code-cli | grep -q '"up":true'
wait_http http://127.0.0.1:13022/
curl -fsS -X POST http://127.0.0.1:13030/api/launch/ohmyfloyd | grep -q '"up":true'
wait_http http://127.0.0.1:13023/
SURFACE_STATUS=$(curl -fsS -H "Authorization: Bearer $CORE_TOKEN" \
  http://127.0.0.1:41414/api/surfaces)
printf '%s' "$SURFACE_STATUS" | python3 -c '
import json,sys
payload=json.load(sys.stdin)
by_id={surface.get("id"): surface for surface in payload.get("surfaces", [])}
for name in ("desktop", "ide", "pty", "launcher"):
    surface=by_id.get(name)
    assert surface is not None and surface.get("verified") is True, (name, surface, payload)
'
BROWSER_RESULT=$(curl -fsS -X POST -H 'Content-Type: application/json' \
  --data '{"url":"about:blank"}' \
  http://127.0.0.1:13030/api/action/open-chrome)
printf '%s' "$BROWSER_RESULT" | python3 -c '
import json,sys
browser=json.load(sys.stdin)
assert browser.get("opened") is True, browser
assert browser.get("cdpPort") == 13032, browser
assert len(browser.get("loaded", [])) == 2, browser
'
BROWSER_CLOSE=$(curl -fsS -X POST http://127.0.0.1:13030/api/action/close-chrome)
printf '%s' "$BROWSER_CLOSE" | python3 -c 'import json,sys; result=json.load(sys.stdin); assert result.get("closed") is True, result'

echo "FLOYD_INSTALLED_SMOKE PASS launcher=installed-app core=41414 frame=13030 vault=13031 browser=13032 ide=13012 terminal=13013 desktop=13010 harness=13014 ff=13022 omf=13023 surfaces=desktop,ide,pty,launcher lsp=typescript,json,html,css,python,shell node=$ACTUAL_NODE_VERSION node_sha256=$ACTUAL_NODE_SHA opencode=$ACTUAL_ENGINE_VERSION opencode_sha256=$ACTUAL_ENGINE_SHA"
