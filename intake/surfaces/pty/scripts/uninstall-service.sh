#!/bin/bash
#
# TerminalOne — remove the always-on LaunchAgent. Full reversal of install-service.sh.
# Stops the running service and deletes the plist. Does not touch app code or ports
# beyond releasing 11001 when the process stops.
#
set -euo pipefail

LABEL="com.floyd.terminalone"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  echo "Removed $PLIST"
else
  echo "No plist found at $PLIST (nothing to remove)"
fi

# Remove the `t1` launcher(s) created by install-service.sh — symlink (legacy) or
# the generated binary (current). Guarded: only delete if it's ours (marker match)
# so we never clobber an unrelated `t1` on the user's PATH.
for d in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  f="$d/t1"
  if [ -L "$f" ]; then
    case "$(readlink "$f")" in *TerminalOne*) rm -f "$f" && echo "Removed $f (symlink)";; esac
  elif [ -f "$f" ] && grep -q 'TerminalOne launcher' "$f" 2>/dev/null; then
    rm -f "$f" && echo "Removed $f (binary)"
  fi
done

# Remove the no-terminal app launcher from both possible install locations.
for APP_BUNDLE in "/Applications/TerminalOne.app" "$HOME/Applications/TerminalOne.app"; do
  if [ -d "$APP_BUNDLE" ]; then rm -rf "$APP_BUNDLE" && echo "Removed $APP_BUNDLE"; fi
done

# Remove the PATH line added to shell rc files by install-service.sh.
# Use ';' not '&&' for mv: grep -vF exits 1 when the marked line is the last
# remaining content (no output lines), but we must still write the (empty) result.
MARK="# added by TerminalOne install-service.sh"
for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
  if [ -f "$rc" ] && grep -qF "$MARK" "$rc" 2>/dev/null; then
    tmp="$(mktemp)"
    grep -vF "$MARK" "$rc" > "$tmp"; mv "$tmp" "$rc" && echo "Cleaned PATH line from $rc"
  fi
done

echo "TerminalOne service uninstalled."
