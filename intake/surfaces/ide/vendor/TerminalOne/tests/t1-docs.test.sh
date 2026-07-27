#!/bin/bash
set -euo pipefail

grep -q 'opens the UI only after health is confirmed' README.md
grep -q 'local-launch.err.log' README.md
grep -q 'local-launch.err.log' scripts/install-service.sh
grep -q 'app-first local launcher' docs/BETA_RELEASE_EVIDENCE.md
