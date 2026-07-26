#!/bin/sh
# Floyd service cull — stops crash-looping and superseded launchd services.
# Non-destructive: plists remain on disk; re-enable any service with
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist
# Usage: sh cull-services.sh          (dry run — prints what it would do)
#        sh cull-services.sh --run    (actually boot them out)
set -u
DOMAIN="gui/$(id -u)"
RUN=${1:-}

# Crash-looping (KeepAlive resurrection churn) + superseded by the FLOYD frame.
CULL="
com.tailserve.adkv2agent
com.tailserve.al9000
com.tailserve.bonsai
com.tailserve.cursem
com.tailserve.deepcode
com.tailserve.flipspeak
com.tailserve.floyddesktop
com.tailserve.floydforge
com.tailserve.floydslabs
com.tailserve.floydportal
com.tailserve.gordy
com.tailserve.indiana-drain-company
com.tailserve.scriptsmith
com.tailserve.secondbrain-open-source
com.tailserve.tail
com.tailserve.tcc
com.tailserve.tear
com.tailserve.gemini
com.tailserve.watchdog
com.legacyoracle.mcp-bridge
space.legacyai.al9000.local-voice
com.floyd.continuity-dashboard
com.floyd.memory_pressure_alert
com.floyd.memory_watchdog
com.floydlabs.mitchresearch.web
"

# NEVER cull these (daily driver):
#   com.floyd.core, com.floyd.frame, com.floyd.surface.*, com.floyd.aterm,
#   com.floyd.cohort, com.floyd.terminalone, com.legacyoracle.mcp-gateway,
#   com.floydslabs.gemini.desktop-commander-mcp, com.tailserve.model-router,
#   com.tailserve.oracle, com.tailserve.apps, com.tailserve.mwide,
#   com.tailserve.nexus, com.tailserve.webswap, com.tailserve.websplain,
#   com.tailserve.fuckbutt-dashboard

for label in $CULL; do
  if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
    if [ "$RUN" = "--run" ]; then
      launchctl bootout "$DOMAIN/$label" 2>/dev/null && echo "CULLED   $label" || echo "FAILED   $label"
    else
      echo "WOULD CULL  $label"
    fi
  else
    echo "NOT LOADED  $label"
  fi
done
[ "$RUN" = "--run" ] || printf '\nDry run only. Re-run with --run to execute.\n'
