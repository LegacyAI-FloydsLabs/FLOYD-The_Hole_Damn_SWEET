#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEST="$ROOT/intake/surfaces"
mkdir -p "$DEST"

clone_remote() {
  id=$1
  url=$2
  target="$DEST/$id"
  if [ -d "$target/.git" ]; then
    actual=$(git -C "$target" remote get-url origin)
    if [ "$actual" != "$url" ]; then
      printf '%s: origin mismatch: %s\n' "$id" "$actual" >&2
      return 1
    fi
    git -C "$target" fetch --prune origin
  else
    git clone --filter=blob:none "$url" "$target"
  fi
}

clone_remote desktop https://github.com/CaptainPhantasy/floyd-desktop-web-v2.git
clone_remote ide https://github.com/CaptainPhantasy/mobile-web-IDE.git
clone_remote tui https://github.com/CaptainPhantasy/OhMyFloyd.git
clone_remote pty https://github.com/CaptainPhantasy/TerminalOne.git

LAUNCHER_SOURCE=/Volumes/Storage/harness-launcher
LAUNCHER_TARGET="$DEST/launcher"
if [ -d "$LAUNCHER_TARGET/.git" ]; then
  git -C "$LAUNCHER_TARGET" fetch --prune origin
else
  # --no-local prohibits Git's local hardlink optimization. This is a real
  # writable copy, not a linked view of the canonical launcher donor.
  git clone --no-local "$LAUNCHER_SOURCE" "$LAUNCHER_TARGET"
fi

printf '%-10s %-12s %-12s %s\n' surface branch head clean
for id in desktop ide tui pty launcher; do
  target="$DEST/$id"
  branch=$(git -C "$target" branch --show-current)
  head=$(git -C "$target" rev-parse --short=12 HEAD)
  if [ -n "$(git -C "$target" status --porcelain)" ]; then clean=no; else clean=yes; fi
  printf '%-10s %-12s %-12s %s\n' "$id" "${branch:-detached}" "$head" "$clean"
  test "$clean" = yes

  # A donor copy may contain relative project symlinks, but it may not link
  # back to any protected original path.
  if find "$target" -type l -exec sh -c '
    for link do
      resolved=$(readlink "$link")
      case "$resolved" in
        /Volumes/Storage/FloydDesktopWeb-v2*|/Volumes/SanDisk1Tb/MWIDE/mobile-web-IDE*|/Volumes/SanDisk1Tb/OhMyFloyd*|/Volumes/SanDisk1Tb/TerminalOne*|/Volumes/Storage/harness-launcher*|/Volumes/applebottom/AGENTS\ FRAMEWORK/ADKv2Agent*)
          printf "protected donor symlink: %s -> %s\n" "$link" "$resolved" >&2
          exit 1
          ;;
      esac
    done
  ' sh {} +; then :; else exit 1; fi
done

relative_probe=$(git -C "$LAUNCHER_SOURCE" ls-files | sed -n '1p')
test -n "$relative_probe"
source_probe="$LAUNCHER_SOURCE/$relative_probe"
target_probe="$LAUNCHER_TARGET/$relative_probe"
test -f "$target_probe"
source_inode=$(stat -f '%d:%i' "$source_probe")
target_inode=$(stat -f '%d:%i' "$target_probe")
test "$source_inode" != "$target_inode"
printf 'launcher_inode_separation=yes source=%s copy=%s\n' "$source_inode" "$target_inode"
