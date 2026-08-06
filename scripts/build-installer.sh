#!/bin/sh
# build-installer.sh — package FLOYD Desktop Suite as a signed macOS PKG installing "FLOYD Desktop Suite.app".
#
# Payload: this repo's runtime files + admitted surface copies + the pinned
# opencode engine + a private node runtime. NO secrets: the staged payload is
# scanned fail-closed before anything is packaged. Keys live only in the
# user's runtime root (~/.floyd/secrets), never in the app.
#
#   FLOYD_SIGN_IDENTITY="Developer ID Installer: ..." ./scripts/build-installer.sh
#   ./scripts/build-installer.sh              # unsigned (dev build)
#
# Output: dist/FLOYD-<version>.pkg + dist/manifest.json (for the updater).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
# Version comes from the repo VERSION file (bumped with each shipped
# improvement); FLOYD_VERSION overrides for one-off builds.
VERSION=${FLOYD_VERSION:-$(tr -d '[:space:]' < "$ROOT/VERSION")}
[ -n "$VERSION" ] || { echo "FATAL: empty VERSION" >&2; exit 1; }
IDENTIFIER="com.floydslabs.floyd"
DIST="$ROOT/dist"
STAGE=$(mktemp -d /tmp/floyd-pkg.XXXXXX)
# Tolerate EACCES when cleaning up (old root-owned installed app may block deletion)
cleanup() { rm -rf "$STAGE" 2>/dev/null || true; }
trap cleanup EXIT

APP="$STAGE/payload/Applications/FLOYD Desktop Suite.app"
RES="$APP/Contents/Resources"
WS="$RES/workstation"
mkdir -p "$APP/Contents/MacOS" "$WS" "$DIST"

echo "==> staging repo (tracked files only)"
(cd "$ROOT" && git archive HEAD) | tar -x -C "$WS"
rm -rf "$WS/scripts"   # build tooling never ships
rm -rf "$WS/plans" "$WS/.agents"   # repo planning docs + agent harness tooling never ship
# ...except the three runtime entrypoints the harness TUIs exec (floyd-agent
# → vault environment + provider handoff) and their scripts/lib dependency.
mkdir -p "$WS/scripts/lib"
for f in \
  scripts/run-with-vault-environment.mjs \
  scripts/vault-provider-handoff.mjs \
  scripts/update-floyd-providers-with-vault.mjs \
  scripts/lib/floyd-provider-update.mjs; do
  rsync -a "$ROOT/$f" "$WS/$f"
done
printf '%s\n' "$VERSION" > "$WS/VERSION"   # updater reads installed version here
# Workspace deps (small; @floyd/* are relative symlinks that survive rsync -a).
rsync -a "$ROOT/node_modules/" "$WS/node_modules/"

echo "==> staging surfaces (runtime copies only — no planning docs, tests, or artifacts)"
for s in desktop ff ide launcher omf pty; do
  src="$ROOT/intake/surfaces/$s"
  [ -d "$src" ] || { echo "FATAL: missing surface $s" >&2; exit 1; }
  mkdir -p "$WS/intake/surfaces/$s"
  rsync -a \
    --exclude ".git" --exclude "artifacts/" --exclude ".env" --exclude ".env.*" \
    --exclude "*.log" --exclude ".DS_Store" \
    --exclude "docs/" --exclude "Issues/" --exclude "SSOT/" \
    --exclude "test/" --exclude "tests/" --exclude "__tests__/" \
    --exclude "Claude.md" --exclude "CLAUDE.md" --exclude "AGENTS.md" --exclude "PLAN.md" \
    --exclude "repository_report.md" --exclude "STABILITY.md" --exclude "DEPLOYMENT.md" \
    --exclude "*.tmp.*" --exclude ".floyd-data/" --exclude "sessions/" \
    "$src/" "$WS/intake/surfaces/$s/"
done

echo "==> staging pinned opencode engine"
ENGINE_SHA=$(python3 -c "import json;print(json.load(open('$ROOT/upstream.lock'))['opencode']['sha256'])")
ENGINE_SRC="${FLOYD_RUNTIME_ROOT:-$HOME/.floyd}/engines/opencode/bin/opencode"
[ -f "$ENGINE_SRC" ] || { echo "FATAL: engine binary not at $ENGINE_SRC" >&2; exit 1; }
ACTUAL=$(shasum -a 256 "$ENGINE_SRC" | cut -d' ' -f1)
[ "$ACTUAL" = "$ENGINE_SHA" ] || { echo "FATAL: engine sha mismatch ($ACTUAL != $ENGINE_SHA)" >&2; exit 1; }
mkdir -p "$RES/engine"
cp "$ENGINE_SRC" "$RES/engine/opencode"
chmod 755 "$RES/engine/opencode"

echo "==> staging node runtime (official self-contained build)"
# Homebrew node links against /opt/homebrew dylibs and cannot be copied.
# Bundle the official nodejs.org binary, cached under dist/.node-cache.
NODE_VER=${FLOYD_NODE_VERSION:-v26.5.0}
NODE_TGZ="$DIST/.node-cache/node-$NODE_VER-darwin-arm64.tar.gz"
if [ ! -f "$NODE_TGZ" ]; then
  mkdir -p "$DIST/.node-cache"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-arm64.tar.gz" -o "$NODE_TGZ"
fi
mkdir -p "$RES/node/bin"
tar -xzf "$NODE_TGZ" -C "$STAGE" "node-$NODE_VER-darwin-arm64/bin/node"
cp "$STAGE/node-$NODE_VER-darwin-arm64/bin/node" "$RES/node/bin/node"
chmod 755 "$RES/node/bin/node"
"$RES/node/bin/node" -e 'process.exit(0)' || { echo "FATAL: bundled node does not run" >&2; exit 1; }

echo "==> writing app bundle skeleton"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>FLOYD Desktop Suite</string>
  <key>CFBundleDisplayName</key><string>FLOYD Desktop Suite</string>
  <key>CFBundleIdentifier</key><string>$IDENTIFIER</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>FLOYD Desktop Suite</string>
  <key>CFBundleIconFile</key><string>FLOYD</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

# The launcher: install/refresh per-user launch agents on every open, then
# surface the frame in the default browser. All paths app-relative.
cat > "$APP/Contents/MacOS/FLOYD Desktop Suite" <<'LAUNCHER'
#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)   # Contents/
WS="$HERE/Resources/workstation"
NODE="$HERE/Resources/node/bin/node"
RUNTIME_ROOT=${FLOYD_RUNTIME_ROOT:-$HOME/.floyd}
AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/Floyd"
mkdir -p "$RUNTIME_ROOT/secrets" "$RUNTIME_ROOT/core" "$RUNTIME_ROOT/engines/opencode/bin" "$AGENT_DIR" "$LOG_DIR"
chmod 700 "$RUNTIME_ROOT" "$RUNTIME_ROOT/secrets"

# Engine binary lives in the runtime root (upstream.lock is runtime-relative).
if ! cmp -s "$HERE/Resources/engine/opencode" "$RUNTIME_ROOT/engines/opencode/bin/opencode" 2>/dev/null; then
  cp "$HERE/Resources/engine/opencode" "$RUNTIME_ROOT/engines/opencode/bin/opencode"
  chmod 755 "$RUNTIME_ROOT/engines/opencode/bin/opencode"
fi

plist() { # label program-args...
  label=$1; shift
  target="$AGENT_DIR/$label.plist"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n'
    printf '<key>Label</key><string>%s</string>\n<key>ProgramArguments</key><array>\n' "$label"
    for a in "$@"; do printf '<string>%s</string>\n' "$a"; done
    printf '</array>\n<key>EnvironmentVariables</key><dict>\n'
    printf '<key>HOME</key><string>%s</string>\n<key>FLOYD_RUNTIME_ROOT</key><string>%s</string>\n' "$HOME" "$RUNTIME_ROOT"
    printf '<key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>\n</dict>\n'
    printf '<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n'
    printf '<key>StandardOutPath</key><string>%s/%s.log</string>\n<key>StandardErrorPath</key><string>%s/%s.log</string>\n' "$LOG_DIR" "$label" "$LOG_DIR" "$label"
    printf '</dict></plist>\n'
  } > "$target"
  chmod 600 "$target"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$target"
}

plist com.floyd.frame "$NODE" "$WS/apps/frame/server/frame-server.mjs"
plist com.floyd.core  "$NODE" "$WS/core/daemon/src/main.ts"

# Wait briefly for the frame, then open it.
i=0; while [ $i -lt 40 ]; do
  if curl -s -o /dev/null "http://127.0.0.1:13030/"; then break; fi
  i=$((i+1)); sleep 0.25
done
open "http://127.0.0.1:13030/"
LAUNCHER
chmod 755 "$APP/Contents/MacOS/FLOYD Desktop Suite"

cp "$ROOT/build-assets/FLOYD.icns" "$APP/Contents/Resources/FLOYD.icns"

echo "==> secret scan (fail closed)"
SCAN_FAIL=0
# Known live-key shapes, requiring the long random tail so provider-table
# prefix literals and short test fixtures (sk-ant-api-test) don't trip it.
PATTERNS='sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{60}|sk-proj-[A-Za-z0-9_-]{60}|sk-svcacct-[A-Za-z0-9_-]{40}|AIzaSy[A-Za-z0-9_-]{33}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60}|gsk_[A-Za-z0-9]{50}|sk-or-v1-[a-f0-9]{60}|xai-[A-Za-z0-9]{60}|tvly-[A-Za-z0-9-]{30}|hf_[A-Za-z]{34}|sk-cp-[A-Za-z0-9-]{40}'
if grep -rIE "$PATTERNS" "$STAGE/payload" --exclude-dir=node_modules -l | head -5 | grep .; then
  echo "FATAL: staged payload contains key-shaped strings (above)" >&2; SCAN_FAIL=1
fi
# Exact-match every real key in THIS machine's Keychain Vault against the
# payload. Catches shapes the generic patterns miss without materializing a
# plaintext credential file.
if /usr/bin/security find-generic-password -a provider-credentials -s space.legacyai.floyd.vault -w >/dev/null 2>&1; then
  if ! python3 - "$STAGE/payload" <<'PYEOF'
import json, os, subprocess, sys
payload = sys.argv[1]
needles = set()
result = subprocess.run(
    ["/usr/bin/security", "find-generic-password", "-a", "provider-credentials",
     "-s", "space.legacyai.floyd.vault", "-w"],
    check=True, capture_output=True, text=True,
)
for entry in json.loads(result.stdout).values():
    k = entry.get("key")
    if k and len(k) >= 12:
        needles.add(k.encode())
bad = []
for root, dirs, files in os.walk(payload):
    dirs[:] = [d for d in dirs if d != "node_modules"]
    for f in files:
        p = os.path.join(root, f)
        try:
            data = open(p, "rb").read()
        except OSError:
            continue
        for n in needles:
            if n in data:
                bad.append(p)
                break
for p in bad[:10]:
    print(p)
sys.exit(1 if bad else 0)
PYEOF
  then
    echo "FATAL: staged payload contains an actual vault key or proxy token (above)" >&2; SCAN_FAIL=1
  fi
fi
if find "$STAGE/payload" \( -name ".env" -o -name ".env.production" -o -name ".env.local" -o -name "provider-keys.json" -o -name "auth.json" -o -name "proxy-tokens.json" \) | grep .; then
  echo "FATAL: staged payload contains secret-bearing filenames (above)" >&2; SCAN_FAIL=1
fi
if grep -rI "/Volumes/Storage\|/Volumes/SanDisk" "$STAGE/payload/Applications/FLOYD Desktop Suite.app/Contents/Resources/workstation" \
     --exclude-dir=node_modules --exclude-dir=intake -l | head -5 | grep .; then
  echo "FATAL: staged payload references dev volumes (above)" >&2; SCAN_FAIL=1
fi
[ "$SCAN_FAIL" = 0 ] || exit 1
echo "    scan clean"

echo "==> building pkg"
PKG="$DIST/FLOYD-$VERSION.pkg"
pkgbuild --root "$STAGE/payload" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location / \
  ${FLOYD_SIGN_IDENTITY:+--sign "$FLOYD_SIGN_IDENTITY"} \
  "$PKG"

SHA=$(shasum -a 256 "$PKG" | cut -d' ' -f1)
SIZE=$(stat -f %z "$PKG")
cat > "$DIST/manifest.json" <<JSON
{
  "name": "FLOYD",
  "version": "$VERSION",
  "pkg_url": "https://www.floydslabs.com/floyd/FLOYD-$VERSION.pkg",
  "sha256": "$SHA",
  "size_bytes": $SIZE,
  "min_macos": "14.0",
  "published_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "==> done"
echo "    $PKG"
echo "    sha256 $SHA ($((SIZE / 1024 / 1024)) MB)"
[ -n "${FLOYD_SIGN_IDENTITY:-}" ] && pkgutil --check-signature "$PKG" | head -3 || echo "    UNSIGNED (set FLOYD_SIGN_IDENTITY to sign)"
