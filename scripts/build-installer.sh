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
SOURCE=$(mktemp -d /tmp/floyd-source.XXXXXX)
# Tolerate EACCES when cleaning up (old root-owned installed app may block deletion)
cleanup() { rm -rf "$STAGE" "$SOURCE" 2>/dev/null || true; }
trap cleanup EXIT

APP="$STAGE/payload/Applications/FLOYD Desktop Suite.app"
RES="$APP/Contents/Resources"
WS="$RES/workstation"
mkdir -p "$APP/Contents/MacOS" "$WS" "$DIST"

echo "==> exporting exact git commit"
(cd "$ROOT" && git archive HEAD) | tar -x -C "$SOURCE"
VERSION=${FLOYD_VERSION:-$(tr -d '[:space:]' < "$SOURCE/VERSION")}
[ -n "$VERSION" ] || { echo "FATAL: empty VERSION" >&2; exit 1; }

echo "==> recreating dependencies, production bundles, and pinned engine"
"$ROOT/scripts/prepare-release-inputs.sh" "$SOURCE"

echo "==> staging repo (tracked source + freshly generated inputs)"
rsync -a --exclude ".floyd-build/" --exclude "node_modules/" "$SOURCE/" "$WS/"
rm -rf "$WS/scripts"   # build tooling never ships
rm -rf "$WS/plans" "$WS/.agents"   # repo planning docs + agent harness tooling never ship
rm -rf "$WS/intake/surfaces" # recopied below with runtime-only exclusions
# ...except the runtime entrypoints the surfaces exec (floyd-agent → vault
# environment + provider handoff; omf/ff launch.sh → Vault verify/lock/
# materialize + OMF vault runner) and their scripts/lib dependencies.
mkdir -p "$WS/scripts/lib"
for f in \
  scripts/run-with-vault-environment.mjs \
  scripts/vault-provider-handoff.mjs \
  scripts/update-floyd-providers-with-vault.mjs \
  scripts/lib/floyd-provider-update.mjs \
  scripts/apply-omf-vault-routing-patch.sh \
  scripts/verify-omf-vault-tools.mjs \
  scripts/lock-omf-credential-store.mjs \
  scripts/materialize-vault-client-config.mjs \
  scripts/run-omf-with-vault.mjs \
  scripts/lib/omf-credential-store.mjs; do
  rsync -a "$SOURCE/$f" "$WS/$f"
done
printf '%s\n' "$VERSION" > "$WS/VERSION"   # updater reads installed version here
# Workspace deps (small; @floyd/* are relative symlinks that survive rsync -a).
rsync -a "$SOURCE/node_modules/" "$WS/node_modules/"
for workspace in packages/contracts packages/sdk engines/opencode core/daemon clients/cli; do
  [ -d "$SOURCE/$workspace/node_modules" ] || continue
  mkdir -p "$WS/$workspace/node_modules"
  rsync -a "$SOURCE/$workspace/node_modules/" "$WS/$workspace/node_modules/"
done

echo "==> staging surfaces (runtime copies only — no planning docs, tests, or artifacts)"
for s in desktop ff ide launcher omf pty; do
  src="$SOURCE/intake/surfaces/$s"
  [ -d "$src" ] || { echo "FATAL: missing surface $s" >&2; exit 1; }
  mkdir -p "$WS/intake/surfaces/$s"
  rsync -a \
    --exclude ".git" --exclude "artifacts/" --exclude ".env" --exclude ".env.*" \
    --exclude "*.log" --exclude ".DS_Store" \
    --exclude "docs/" --exclude "Issues/" --exclude "SSOT/" \
    --exclude "test/" --exclude "tests/" --exclude "__tests__/" \
    --exclude "README.md" --exclude "FLOYD.md" \
    --exclude "scripts/install-service.sh" --exclude "vendor/TerminalOne/CURSEM_COPY_PROVENANCE.md" \
    --exclude "Claude.md" --exclude "CLAUDE.md" --exclude "AGENTS.md" --exclude "PLAN.md" \
    --exclude "repository_report.md" --exclude "STABILITY.md" --exclude "DEPLOYMENT.md" \
    --exclude "*.tmp.*" --exclude ".floyd-data/" --exclude "sessions/" \
    "$src/" "$WS/intake/surfaces/$s/"
done

echo "==> staging pinned opencode engine"
ENGINE_SHA=$(python3 -c "import json;print(json.load(open('$SOURCE/upstream.lock'))['opencode']['sha256'])")
ENGINE_SRC="$SOURCE/.floyd-build/opencode/opencode"
[ -f "$ENGINE_SRC" ] || { echo "FATAL: prepared engine binary missing at $ENGINE_SRC" >&2; exit 1; }
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
NODE_SHA=${FLOYD_NODE_SHA256:-ee920559aaa2391569cff4d737e3b83963430e3a14dedd91bfe0ff53171b5af9}
if [ ! -f "$NODE_TGZ" ]; then
  mkdir -p "$DIST/.node-cache"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-arm64.tar.gz" -o "$NODE_TGZ"
fi
ACTUAL_NODE_SHA=$(shasum -a 256 "$NODE_TGZ" | cut -d' ' -f1)
[ "$ACTUAL_NODE_SHA" = "$NODE_SHA" ] || { echo "FATAL: node archive sha mismatch ($ACTUAL_NODE_SHA != $NODE_SHA)" >&2; exit 1; }
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

cp "$SOURCE/build-assets/FLOYD.icns" "$APP/Contents/Resources/FLOYD.icns"

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
     --exclude-dir=node_modules -l | head -5 | grep .; then
  echo "FATAL: staged payload references dev volumes (above)" >&2; SCAN_FAIL=1
fi
[ "$SCAN_FAIL" = 0 ] || exit 1
echo "    scan clean"

echo "==> building pkg"
PKG="$DIST/FLOYD-$VERSION.pkg"
COMPONENTS="$STAGE/components.plist"
# Package the staged tree as a literal payload. An analyzed component list
# makes Installer apply bundle upgrade/relocation rules, which can leave a
# partial app at /Applications even when every file is present in the PKG.
# An empty component list emits no upgrade targets and an empty relocation
# table, so every freshly staged file is installed at its exact payload path.
cat > "$COMPONENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array/></plist>
PLIST
pkgbuild --root "$STAGE/payload" \
  --component-plist "$COMPONENTS" \
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
