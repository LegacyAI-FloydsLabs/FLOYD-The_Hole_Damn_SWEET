#!/bin/zsh
# new-world-bootstrap.sh — adopt FLOYD_WORKSTATION on a fresh macOS install.
#
# Run from the repo root on the new OS:
#   cd /Volumes/Storage/FLOYD_WORKSTATION && ./scripts/new-world-bootstrap.sh
#
# Idempotent. Installs nothing globally except the two LaunchAgents.
# Every step reports PASS/FAIL and the script never aborts the machine state.
set -u

PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
echo "FLOYD_WORKSTATION new-world bootstrap"
echo "repo: $REPO"
echo

# 1. Volume + permission sanity ------------------------------------------------
echo "[1/6] volumes and permissions"
[ -d "${FLOYD_RUNTIME_ROOT:-$HOME/.floyd}" ] || [ -d /Volumes/Storage ] && ok "runtime location available" || ok "runtime will be created at ~/.floyd on first run"
[ -r "$REPO/apps/frame/server/frame-server.mjs" ] && ok "repo readable" || bad "repo unreadable — grant Full Disk / Removable Volumes access to your terminal in System Settings > Privacy"

# 2. Node runtime --------------------------------------------------------------
echo "[2/6] node runtime"
if [ -x /opt/homebrew/bin/node ]; then
  ok "homebrew node: $(/opt/homebrew/bin/node -v)"
elif command -v node >/dev/null 2>&1; then
  ok "system node: $(node -v) (frame-server falls back to this automatically)"
else
  bad "no node found — install Homebrew then 'brew install node', or install node any way you like"
fi

# 3. Secrets vault -------------------------------------------------------------
echo "[3/6] provider-key vault"
RUNTIME_ROOT=${FLOYD_RUNTIME_ROOT:-}
if [ -z "$RUNTIME_ROOT" ]; then
  if [ -d /Volumes/Storage/FLOYD_RUNTIME ]; then RUNTIME_ROOT=/Volumes/Storage/FLOYD_RUNTIME
  else RUNTIME_ROOT="$HOME/.floyd"; fi
fi
VAULT=$RUNTIME_ROOT/secrets/provider-keys.json
if [ -f "$VAULT" ]; then
  perms=$(stat -f %Lp "$VAULT")
  [ "$perms" = "600" ] && ok "vault present, mode 600" || { chmod 600 "$VAULT" && ok "vault present, tightened to 600"; }
else
  bad "vault missing at $VAULT — restore FLOYD_RUNTIME/secrets or re-enter keys in the frame Keys panel"
fi

# 4. LaunchAgents (the ONLY persistent services this repo installs) -----------
echo "[4/6] LaunchAgents (com.floyd.core, com.floyd.frame)"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/Floyd" "$HOME/Library/Logs/floyd"
# Plists are rendered for THIS machine (path, user, node) — never copied static.
if sh "$REPO/scripts/render-launch-agents.sh" >/dev/null 2>&1; then
  ok "com.floyd.frame plist rendered for this machine"
else
  bad "render-launch-agents.sh failed"
fi
label=com.floyd.frame
dst="$HOME/Library/LaunchAgents/$label.plist"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
if launchctl bootstrap "gui/$(id -u)" "$dst" 2>/dev/null; then
  ok "$label loaded"
else
  launchctl kickstart "gui/$(id -u)/$label" 2>/dev/null && ok "$label already loaded, kickstarted" || bad "$label failed to load — check $dst"
fi
# Core is release-pinned: install via scripts/install-core-launch-agent.sh once
# a runtime root exists (it builds, health-gates, and can roll back).
[ -f "$HOME/Library/LaunchAgents/com.floyd.core.plist" ] \
  && ok "com.floyd.core already installed" \
  || echo "  NOTE  com.floyd.core not installed — run: npm run core:install"

# 5. Frame reachable -----------------------------------------------------------
echo "[5/6] frame health"
sleep 2
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:13030/ 2>/dev/null)
[ "$code" = "200" ] && ok "frame serving on 13030" || bad "frame not answering on 13030 (HTTP ${code:-none}) — check ~/Library/Logs/Floyd/frame.err.log"

# 6. Known external dependencies (informational) -------------------------------
echo "[6/6] external dependencies (informational, not fatal)"
[ -x /opt/homebrew/libexec/floyd-harnesses/floyd-ff-real ] \
  && ok "floyd-ff-real binary present (launcher agents runnable)" \
  || echo "  NOTE  floyd-ff-real not installed yet — the nine launcher agents need it; copy from old world /opt/homebrew/libexec/floyd-harnesses/"
[ -d /Volumes/SanDisk1Tb ] \
  && ok "SanDisk1Tb mounted (port-registry reachable)" \
  || echo "  NOTE  SanDisk1Tb not mounted — only FLOYD.md's port-registry reference cares"

echo
echo "bootstrap complete: $PASS pass, $FAIL fail"
[ $FAIL -eq 0 ] && echo "FLOYD_WORKSTATION is live on this machine." || echo "Fix FAIL lines above, then re-run. Idempotent."
exit $FAIL
