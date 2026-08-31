#!/bin/sh
# pkgbuild postinstall: expand the complete staged application without
# macOS Installer's component-bundle merge/relocation behavior.
set -eu

TARGET_VOLUME=${3:-/}
ARCHIVE_DIR="$TARGET_VOLUME/Library/Application Support/FLOYD Installer"
ARCHIVE="$ARCHIVE_DIR/FLOYD Desktop Suite.zip"
APPLICATIONS="$TARGET_VOLUME/Applications"
APP="$APPLICATIONS/FLOYD Desktop Suite.app"
EXTRACTED="$ARCHIVE_DIR/extracted"
CANDIDATE="$EXTRACTED/FLOYD Desktop Suite.app"
PREVIOUS="$ARCHIVE_DIR/previous.app"
IDE_ROOT="$CANDIDATE/Contents/Resources/workstation/intake/surfaces/ide"

[ -f "$ARCHIVE" ] || {
  echo "FATAL: packaged application archive is missing: $ARCHIVE" >&2
  exit 1
}

# Recover an interrupted prior upgrade before cleaning temporary state. If the
# previous postinstall lost power after moving the live app aside, PREVIOUS is
# the only complete installed copy and must never be deleted on the next run.
if [ ! -e "$APP" ] && [ -e "$PREVIOUS" ]; then
  echo "Recovering application preserved by an interrupted prior install"
  mv "$PREVIOUS" "$APP" || {
    echo "FATAL: could not recover the previously installed application" >&2
    exit 1
  }
fi
rm -rf "$EXTRACTED"
if [ -e "$PREVIOUS" ]; then
  [ -e "$APP" ] || {
    echo "FATAL: refusing to discard the only recoverable application copy" >&2
    exit 1
  }
  rm -rf "$PREVIOUS"
fi
mkdir -p "$APPLICATIONS" "$EXTRACTED"
ditto -x -k "$ARCHIVE" "$EXTRACTED"

for required in \
  "$CANDIDATE/Contents/MacOS/FLOYD Desktop Suite" \
  "$CANDIDATE/Contents/Resources/node/bin/node" \
  "$CANDIDATE/Contents/Resources/node/bin/npm" \
  "$CANDIDATE/Contents/Resources/node/bin/npx" \
  "$CANDIDATE/Contents/Resources/engine/opencode"; do
  [ -x "$required" ] || {
    echo "FATAL: packaged application executable is missing: $required" >&2
    exit 1
  }
done
for required in \
  "$CANDIDATE/Contents/Resources/workstation/intake/surfaces/desktop/dist-server/index.js" \
  "$CANDIDATE/Contents/Resources/workstation/intake/surfaces/desktop/dist/index.html" \
  "$CANDIDATE/Contents/Resources/workstation/intake/surfaces/ide/dist/index.html" \
  "$CANDIDATE/Contents/Resources/workstation/release.json" \
  "$CANDIDATE/Contents/Resources/node/lib/node_modules/npm/bin/npm-cli.js" \
  "$CANDIDATE/Contents/Resources/workstation/apps/frame/extensions/floyd-tty-bridge/node_modules/@xterm/addon-fit/lib/addon-fit.js" \
  "$CANDIDATE/Contents/Resources/workstation/apps/frame/extensions/floyd-tty-bridge/node_modules/@xterm/addon-webgl/lib/addon-webgl.js" \
  "$CANDIDATE/Contents/Resources/workstation/apps/frame/extensions/floyd-tty-bridge/node_modules/@xterm/addon-canvas/lib/addon-canvas.js" \
  "$CANDIDATE/Contents/Resources/workstation/apps/frame/extensions/floyd-tty-bridge/node_modules/@xterm/addon-search/lib/addon-search.js" \
  "$CANDIDATE/Contents/Resources/workstation/apps/frame/extensions/floyd-tty-bridge/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js"; do
  [ -f "$required" ] || {
    echo "FATAL: installed application is incomplete: $required" >&2
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
  required="$IDE_ROOT/node_modules/.bin/$launcher"
  [ -x "$required" ] || {
    echo "FATAL: packaged application IDE runtime launcher is missing: $required" >&2
    exit 1
  }
done
TS_SERVER="$IDE_ROOT/node_modules/typescript/lib/tsserver.js"
[ -f "$TS_SERVER" ] || {
  echo "FATAL: packaged application TypeScript server runtime is missing: $TS_SERVER" >&2
  exit 1
}

if [ -e "$APP" ]; then
  mv "$APP" "$PREVIOUS"
fi
if ! mv "$CANDIDATE" "$APP"; then
  [ ! -e "$PREVIOUS" ] || mv "$PREVIOUS" "$APP"
  echo "FATAL: could not place the complete application at $APP" >&2
  exit 1
fi

rm -rf "$PREVIOUS" "$EXTRACTED"
rm -f "$ARCHIVE"
rmdir "$ARCHIVE_DIR" 2>/dev/null || true
exit 0
