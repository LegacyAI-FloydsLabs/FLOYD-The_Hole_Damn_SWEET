#!/bin/sh
# ship.sh — streamlined FLOYD update pipeline.
#
#   scripts/ship.sh local
#       Fast dogfood path: sync the working tree's runtime files into the
#       installed app and restart the launch agents. Seconds, no pkg rebuild.
#       Use after editing surfaces (CURSEM-IDE, frame, core, lib) to see the
#       change live in the launcher-icon app.
#
#   scripts/ship.sh release [patch|minor|major]
#       Distribution path: require a clean tree, bump VERSION (default patch),
#       commit the bump, build the signed pkg, notarize + staple via the
#       floyd-notary keychain profile, install locally, verify.
#
# Env overrides: FLOYD_SIGN_IDENTITY, FLOYD_NOTARY_PROFILE, FLOYD_APP,
#                FLOYD_SKIP_INSTALL=1 (release: build+notarize only)
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
APP=${FLOYD_APP:-"/Applications/FLOYD Desktop Suite.app"}
WS="$APP/Contents/Resources/workstation"
FRAME_URL="http://127.0.0.1:13030/"
MODE=${1:-}

admin() { # run a command as root via the native macOS auth dialog
  osascript -e "do shell script \"$1\" with administrator privileges" >/dev/null
}

ensure_writable_ws() {
  [ -d "$WS" ] || { echo "FATAL: $WS missing — is FLOYD installed?"; exit 1; }
  if [ ! -w "$WS" ]; then
    echo "==> installed tree is root-owned; claiming it (native auth prompt)"
    admin "chown -R $(id -u):$(id -g) '$WS'"
  fi
}

restart_agents() {
  uid=$(id -u)
  for label in com.floyd.frame com.floyd.core; do
    launchctl kickstart -k "gui/$uid/$label" 2>/dev/null || true
  done
  i=0; while [ $i -lt 40 ]; do
    curl -sf -o /dev/null "$FRAME_URL" && break
    i=$((i+1)); sleep 0.25
  done
  curl -sf -o /dev/null "$FRAME_URL" || { echo "FATAL: frame did not come up — see ~/Library/Logs/Floyd/com.floyd.frame.log"; exit 1; }
  echo "    frame serving $FRAME_URL"
}

case "$MODE" in
local)
  echo "==> syncing working tree into installed app"
  ensure_writable_ws
  # Same shape as the installer payload: tracked files (+ untracked, not
  # ignored), minus build tooling. --delete keeps the installed tree honest.
  LIST=$(mktemp /tmp/floyd-ship.XXXXXX)
  trap 'rm -f "$LIST"' EXIT
  (cd "$ROOT" && git ls-files -co --exclude-standard) \
    | grep -v -E '^(scripts/|dist/|quarantine/|dogfood-output/|\.planning/)' > "$LIST"
  rsync -a --delete --files-from="$LIST" --exclude 'node_modules/' "$ROOT/" "$WS/"
  # node_modules: content-addressed enough for rsync -a to skip when unchanged.
  rsync -a "$ROOT/node_modules/" "$WS/node_modules/"
  printf '%s\n' "$(tr -d '[:space:]' < "$ROOT/VERSION")" > "$WS/VERSION"
  echo "==> restarting agents"
  restart_agents
  echo "==> local sync live"
  ;;

release)
  LEVEL=${2:-patch}
  case "$LEVEL" in patch|minor|major) ;; *) echo "FATAL: level must be patch|minor|major"; exit 1;; esac
  echo "==> checking tree"
  if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
    echo "FATAL: uncommitted tracked changes — the installer packages git HEAD." >&2
    echo "       Commit first, or use: scripts/ship.sh local" >&2
    exit 1
  fi
  OLD=$(tr -d '[:space:]' < "$ROOT/VERSION")
  NEW=$(echo "$OLD" | awk -F. -v l="$LEVEL" '{
    if (l=="major") { $1++; $2=0; $3=0 }
    else if (l=="minor") { $2++; $3=0 }
    else { $3++ }
    print $1"."$2"."$3 }')
  echo "==> version $OLD -> $NEW"
  printf '%s\n' "$NEW" > "$ROOT/VERSION"
  git -C "$ROOT" add VERSION
  git -C "$ROOT" commit -m "chore(release): v$NEW"

  echo "==> building signed pkg"
  IDENTITY=${FLOYD_SIGN_IDENTITY:-$(security find-identity -v | sed -n 's/.*"\(Developer ID Installer:[^"]*\)".*/\1/p' | head -1)}
  [ -n "$IDENTITY" ] || { echo "FATAL: no Developer ID Installer identity in keychain"; exit 1; }
  FLOYD_SIGN_IDENTITY="$IDENTITY" "$ROOT/scripts/build-installer.sh"

  PKG="$ROOT/dist/FLOYD-$NEW.pkg"
  PROFILE=${FLOYD_NOTARY_PROFILE:-floyd-notary}
  echo "==> notarizing (profile: $PROFILE)"
  xcrun notarytool submit "$PKG" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$PKG"
  echo "    stapled: $PKG"

  if [ "${FLOYD_SKIP_INSTALL:-0}" != 1 ]; then
    echo "==> installing locally (native auth prompt)"
    admin "installer -pkg '$PKG' -target /"
    restart_agents
  fi

  echo "==> release $NEW ready"
  echo "    pkg:      $PKG"
  echo "    manifest: $ROOT/dist/manifest.json"
  if [ -x "$ROOT/scripts/publish-release.sh" ]; then
    "$ROOT/scripts/publish-release.sh" "$NEW"
  else
    echo "    publish:  upload both files to https://www.floydslabs.com/floyd/"
    echo "              (no scripts/publish-release.sh yet)"
  fi
  ;;

*)
  echo "usage: scripts/ship.sh local | release [patch|minor|major]" >&2
  exit 2
  ;;
esac
