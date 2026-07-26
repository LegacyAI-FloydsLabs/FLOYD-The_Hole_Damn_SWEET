#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE="$ROOT/com.floyd.core.plist"
RUNTIME_ROOT=${FLOYD_RUNTIME_ROOT:-/Volumes/Storage/FLOYD_RUNTIME}
RELEASES="$RUNTIME_ROOT/releases/core"
CURRENT="$RELEASES/current"
AGENT_DIR="$HOME/Library/LaunchAgents"
TARGET="$AGENT_DIR/com.floyd.core.plist"
LOG_DIR="$HOME/Library/Logs/floyd"
DOMAIN="gui/$(id -u)"
LABEL="com.floyd.core"
TOKEN_FILE=${FLOYD_GATEWAY_TOKEN_FILE:-$RUNTIME_ROOT/core/gateway.token}

if test -n "$(git -C "$ROOT" status --porcelain)"; then
  printf 'Refusing to deploy an uncommitted Floyd working tree.\n' >&2
  exit 1
fi

COMMIT=$(git -C "$ROOT" rev-parse HEAD)
RELEASE="$RELEASES/$COMMIT"
STAGING=
DEPS=
NEW_CURRENT=
PLIST_BACKUP=

cleanup() {
  test -z "$STAGING" || rm -rf "$STAGING"
  test -z "$DEPS" || rm -rf "$DEPS"
  test -z "$NEW_CURRENT" || rm -f "$NEW_CURRENT"
  test -z "$PLIST_BACKUP" || rm -f "$PLIST_BACKUP"
}
trap cleanup EXIT HUP INT TERM

/usr/bin/plutil -lint "$SOURCE" >/dev/null
node_path=$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$SOURCE")
entrypoint=$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:1" "$SOURCE")
working_directory=$(/usr/libexec/PlistBuddy -c "Print :WorkingDirectory" "$SOURCE")
test -x "$node_path"
test -r "$TOKEN_FILE"
mkdir -p "$RELEASES" "$AGENT_DIR" "$LOG_DIR"

if test ! -d "$RELEASE"; then
  STAGING=$(mktemp -d "$RELEASES/.build.$COMMIT.XXXXXX")
  DEPS=$(mktemp -d "$RELEASES/.deps.$COMMIT.XXXXXX")
  git -C "$ROOT" archive "$COMMIT" | tar -x -C "$STAGING"
  pnpm --dir "$ROOT" --filter @floyd/core-daemon deploy --legacy --prod "$DEPS"
  cp -R "$DEPS/node_modules" "$STAGING/node_modules"

  # Node deliberately refuses to type-strip TypeScript below node_modules.
  # Keep Floyd workspace packages in their release-native locations and link
  # them from node_modules; vendor only the external dependency closure.
  rm -rf "$STAGING/node_modules/@floyd" "$STAGING/node_modules/.pnpm/node_modules/@floyd"
  find "$STAGING/node_modules/.pnpm" -maxdepth 1 -type d -name '@floyd+*' -exec rm -rf {} +
  mkdir -p "$STAGING/node_modules/@floyd"
  ln -s ../../packages/contracts "$STAGING/node_modules/@floyd/contracts"
  ln -s ../../engines/opencode "$STAGING/node_modules/@floyd/opencode-runtime"
  rm -rf "$STAGING/node_modules/@opencode-ai"
  ln -s .pnpm/node_modules/@opencode-ai "$STAGING/node_modules/@opencode-ai"

  built_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  node_version=$($node_path --version)
  printf '{\n  "source_commit": "%s",\n  "built_at": "%s",\n  "node_version": "%s"\n}\n' \
    "$COMMIT" "$built_at" "$node_version" > "$STAGING/release.json"

  bad_link=0
  while IFS= read -r link; do
    resolved=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$link")
    case "$resolved" in
      "$ROOT"/*)
        printf 'Release contains a live-source link: %s -> %s\n' "$link" "$resolved" >&2
        bad_link=1
        ;;
    esac
  done <<EOF
$(find "$STAGING" -type l)
EOF
  test "$bad_link" -eq 0

  "$node_path" --input-type=module - "$STAGING" <<'NODE'
import { pathToFileURL } from "node:url";
const root = process.argv[2];
await import(pathToFileURL(`${root}/core/daemon/src/http.ts`).href);
NODE

  mv "$STAGING" "$RELEASE"
  STAGING=
fi

test -f "$RELEASE/release.json"
case "$entrypoint" in "$CURRENT"/*) ;; *) printf 'Plist entrypoint is not release-pinned: %s\n' "$entrypoint" >&2; exit 1 ;; esac
test "$working_directory" = "$CURRENT"

OLD_CURRENT=
if test -L "$CURRENT"; then OLD_CURRENT=$(readlink "$CURRENT"); fi
NEW_CURRENT="$RELEASES/.current.$$"
ln -s "$RELEASE" "$NEW_CURRENT"
# macOS mv follows a destination symlink to a directory unless -h is used.
# Without -h, an upgrade silently deposits NEW_CURRENT inside the old release.
mv -fh "$NEW_CURRENT" "$CURRENT"
NEW_CURRENT=
test -f "$entrypoint"

if test -f "$TARGET"; then
  PLIST_BACKUP=$(mktemp /tmp/com.floyd.core.plist.XXXXXX)
  cp "$TARGET" "$PLIST_BACKUP"
fi

wait_for_release_health() {
  attempt=0
  while test "$attempt" -lt 80; do
    body=$(token=$(tr -d '\r\n' < "$TOKEN_FILE") \
      && curl -fsS --max-time 2 -H "Authorization: Bearer $token" \
        http://127.0.0.1:41414/api/health 2>/dev/null) || body=
    if test -n "$body" && printf '%s' "$body" | "$node_path" --input-type=module -e '
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!health.ok || !health.engine?.ok || health.release?.source_commit !== process.argv[1]) process.exit(1);
    ' "$COMMIT" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  return 1
}

stop_service() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  attempt=0
  while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    test "$attempt" -lt 50 || return 1
    sleep 0.1
  done
}

rollback_service() {
  set +e
  stop_service
  if test -n "$OLD_CURRENT"; then
    rollback_link="$RELEASES/.rollback.$$"
    ln -s "$OLD_CURRENT" "$rollback_link"
    mv -fh "$rollback_link" "$CURRENT"
  else
    rm -f "$CURRENT"
  fi
  if test -n "$PLIST_BACKUP"; then
    install -m 600 "$PLIST_BACKUP" "$TARGET"
    launchctl bootstrap "$DOMAIN" "$TARGET" >/dev/null 2>&1
  fi
  set -e
}

if ! install -m 600 "$SOURCE" "$TARGET"; then
  rollback_service
  printf 'Could not install Floyd Core LaunchAgent; prior service restored.\n' >&2
  exit 1
fi
if ! stop_service || ! launchctl bootstrap "$DOMAIN" "$TARGET"; then
  rollback_service
  printf 'Could not start Floyd Core release; prior service restored.\n' >&2
  exit 1
fi
if ! wait_for_release_health; then
  rollback_service
  printf 'Floyd Core release failed health/provenance; prior service restored. Inspect %s/core.err.log\n' "$LOG_DIR" >&2
  exit 1
fi

pid=$(launchctl print "$DOMAIN/$LABEL" | sed -n 's/^[[:space:]]*pid = //p' | sed -n '1p')
printf 'CORE_RELEASE PASS commit=%s release=%s\n' "$COMMIT" "$RELEASE"
printf 'CORE_LAUNCH_AGENT PASS label=%s pid=%s plist=%s\n' "$LABEL" "$pid" "$TARGET"
