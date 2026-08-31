#!/bin/sh
# Recreate every generated input consumed by the macOS installer.
# Usage: scripts/prepare-release-inputs.sh [source-root]
set -eu

ROOT=${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)}
NPM_FLAGS="--no-audit --no-fund"
BUILD_ROOT="$ROOT/.floyd-build"

NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
[ "$NODE_MAJOR" -ge 26 ] || {
  echo "FATAL: release builds require Node 26 or newer (found $(node --version))" >&2
  exit 1
}

need() {
  [ -f "$ROOT/$1" ] || { echo "FATAL: clean build input missing: $1" >&2; exit 1; }
}

for file in \
  pnpm-lock.yaml \
  intake/surfaces/desktop/package-lock.json \
  intake/surfaces/ide/package-lock.json \
  intake/surfaces/launcher/package-lock.json \
  intake/surfaces/pty/package-lock.json \
  apps/frame/extensions/floyd-tty-bridge/package-lock.json \
  upstream.lock; do
  need "$file"
done

echo "==> installing locked dependencies"
echo "    pnpm install: root workspace"
(cd "$ROOT" && npx --yes pnpm@11.24.0 install --frozen-lockfile)
for project in intake/surfaces/desktop \
  intake/surfaces/ide \
  intake/surfaces/launcher \
  intake/surfaces/pty \
  apps/frame/extensions/floyd-tty-bridge; do
  echo "    npm ci: $project"
  (cd "$ROOT/$project" && npm ci $NPM_FLAGS)
done

echo "==> building production surfaces"
rm -rf \
  "$ROOT/intake/surfaces/desktop/dist" \
  "$ROOT/intake/surfaces/desktop/dist-server" \
  "$ROOT/intake/surfaces/ide/dist"
(cd "$ROOT/intake/surfaces/desktop" && npm run build)
(cd "$ROOT/intake/surfaces/ide" && npm run build)

for output in \
  intake/surfaces/desktop/dist/index.html \
  intake/surfaces/desktop/dist-server/index.js \
  intake/surfaces/ide/dist/index.html; do
  [ -f "$ROOT/$output" ] || { echo "FATAL: production build did not create $output" >&2; exit 1; }
done

echo "==> pruning build-only dependencies"
(cd "$ROOT" && CI=true npx --yes pnpm@11.24.0 install --prod --frozen-lockfile)
for project in intake/surfaces/desktop \
  intake/surfaces/ide \
  intake/surfaces/launcher \
  intake/surfaces/pty \
  apps/frame/extensions/floyd-tty-bridge; do
  echo "    npm prune --omit=dev: $project"
  (cd "$ROOT/$project" && npm prune --omit=dev $NPM_FLAGS)
done

echo "==> acquiring pinned OpenCode executable"
mkdir -p "$BUILD_ROOT/downloads" "$BUILD_ROOT/opencode"
LOCK="$ROOT/upstream.lock"
read_lock() {
  python3 -c "import json; print(json.load(open('$LOCK'))['opencode']['$1'])"
}
OPENCODE_URL=$(read_lock artifact_url)
OPENCODE_ARCHIVE_SHA=$(read_lock artifact_sha256)
OPENCODE_MEMBER=$(read_lock artifact_binary_path)
OPENCODE_BINARY_SHA=$(read_lock sha256)
ARCHIVE="$BUILD_ROOT/downloads/opencode.tgz"

if [ -n "${FLOYD_OPENCODE_ARCHIVE:-}" ]; then
  cp "$FLOYD_OPENCODE_ARCHIVE" "$ARCHIVE"
else
  curl -fL --retry 3 --retry-delay 2 "$OPENCODE_URL" -o "$ARCHIVE"
fi

ACTUAL_ARCHIVE_SHA=$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)
[ "$ACTUAL_ARCHIVE_SHA" = "$OPENCODE_ARCHIVE_SHA" ] || {
  echo "FATAL: OpenCode archive sha mismatch ($ACTUAL_ARCHIVE_SHA != $OPENCODE_ARCHIVE_SHA)" >&2
  exit 1
}

rm -rf "$BUILD_ROOT/opencode/extracted"
mkdir -p "$BUILD_ROOT/opencode/extracted"
tar -xzf "$ARCHIVE" -C "$BUILD_ROOT/opencode/extracted" "$OPENCODE_MEMBER"
OPENCODE_BIN="$BUILD_ROOT/opencode/opencode"
cp "$BUILD_ROOT/opencode/extracted/$OPENCODE_MEMBER" "$OPENCODE_BIN"
chmod 755 "$OPENCODE_BIN"
ACTUAL_BINARY_SHA=$(shasum -a 256 "$OPENCODE_BIN" | cut -d' ' -f1)
[ "$ACTUAL_BINARY_SHA" = "$OPENCODE_BINARY_SHA" ] || {
  echo "FATAL: OpenCode binary sha mismatch ($ACTUAL_BINARY_SHA != $OPENCODE_BINARY_SHA)" >&2
  exit 1
}

echo "==> release inputs ready"
echo "    OpenCode $ACTUAL_BINARY_SHA"
