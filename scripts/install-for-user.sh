#!/bin/sh
# Install a verified release ZIP into the invoking user's Applications folder.
set -eu
ARCHIVE=${1:?Usage: install-for-user.sh /absolute/path/FLOYD-version.app.zip}
[ "$(id -u)" != 0 ] || { echo 'Run this as your regular Mac account, without sudo.' >&2; exit 1; }
[ -f "$ARCHIVE" ] || { echo "Application archive missing: $ARCHIVE" >&2; exit 1; }
APPLICATIONS="$HOME/Applications"
mkdir -p "$APPLICATIONS"
STAGE=$(mktemp -d "$APPLICATIONS/.floyd-install.XXXXXX")
APP="$APPLICATIONS/FLOYD Desktop Suite.app"
CANDIDATE="$STAGE/FLOYD Desktop Suite.app"
ditto -x -k "$ARCHIVE" "$STAGE"
"$CANDIDATE/Contents/Resources/node/bin/node" \
  "$CANDIDATE/Contents/Resources/verify-package-payload.mjs" verify "$CANDIDATE"
PREVIOUS=""
if [ -e "$APP" ]; then
  PREVIOUS="$STAGE/previous.app"
  mv "$APP" "$PREVIOUS"
fi
if ! mv "$CANDIDATE" "$APP"; then
  [ -z "$PREVIOUS" ] || mv "$PREVIOUS" "$APP"
  echo "Could not install application; previous copy restored." >&2
  exit 1
fi
if [ -n "$PREVIOUS" ]; then
  echo "Previous app preserved at: $PREVIOUS"
else
  rmdir "$STAGE"
fi
echo "Installed for $(id -un): $APP"
echo "Open this application to register your account's FLOYD services. Existing ~/.floyd data is preserved."
