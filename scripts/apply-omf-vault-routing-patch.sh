#!/bin/zsh
set -euo pipefail

ROOT="${1:-/Volumes/SanDisk1Tb/OhMyFloyd}"
HERE="${0:A:h}"
PATCH="${HERE}/../intake/surfaces/omf/patches/vault-provider-tools.patch"
FAIL_CLOSED_PATCH="${HERE}/../intake/surfaces/omf/patches/vault-provider-tools-fail-closed.patch"
TAVILY="${ROOT}/packages/coding-agent/src/web/search/providers/tavily.ts"
GITHUB="${ROOT}/packages/coding-agent/src/web/scrapers/github.ts"

[ -d "${ROOT}/.git" ] || { echo "[omf-vault] canonical source unavailable: ${ROOT}" >&2; exit 66; }
[ -f "${PATCH}" ] || { echo "[omf-vault] patch missing: ${PATCH}" >&2; exit 66; }
[ -f "${FAIL_CLOSED_PATCH}" ] || { echo "[omf-vault] patch missing: ${FAIL_CLOSED_PATCH}" >&2; exit 66; }

if grep -q "Floyd Vault Tavily route is required" "${TAVILY}" \
    && grep -q "Floyd Vault GitHub route is required" "${GITHUB}"; then
    echo "OMF_VAULT_PATCH_CHANGED=0"
    exit 0
fi

if grep -q "DEFAULT_TAVILY_SEARCH_URL" "${TAVILY}" \
    && grep -q 'return "https://api.github.com"' "${GITHUB}"; then
    git -C "${ROOT}" apply --check "${FAIL_CLOSED_PATCH}"
    git -C "${ROOT}" apply "${FAIL_CLOSED_PATCH}"
    echo "[omf-vault] provider-tool routing made fail closed"
    echo "OMF_VAULT_PATCH_CHANGED=1"
    exit 0
fi

git -C "${ROOT}" apply --check "${PATCH}"
git -C "${ROOT}" apply "${PATCH}"
echo "[omf-vault] provider-tool routing patch applied"
echo "OMF_VAULT_PATCH_CHANGED=1"
