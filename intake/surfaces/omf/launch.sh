#!/bin/zsh
# OMF plane launcher — the frame execs this as the TerminalOne SHELL.
# The monorepo runtime copy is ONLY the compiled binary (bin/omp); the
# canonical app (source, build toolchain, branding guard) lives at
# /Volumes/SanDisk1Tb/OhMyFloyd and is where updates land.
#
# On load: 1) canonical self-heals Floyd branding, 2) Vault source routing is
# patched and rebuilt if changed, 3) a candidate binary must pass the compiled
# Vault proof before replacing the shipped copy, 4) the shipped copy must pass
# its fail-closed marker gate immediately before execution.

# Canonical exists only on the dev machine; installed apps run the shipped copy.
CANON="/Volumes/SanDisk1Tb/OhMyFloyd"
CANON_BIN="${CANON}/packages/coding-agent/dist/omp"
HERE="${0:A:h}"
COPY_BIN="${HERE}/bin/omp"
VERIFY_TOOLS="${HERE}/../../../scripts/verify-omf-vault-tools.mjs"
CANON_READY=1
PATCH_RESULT=""

if [ -d "${CANON}" ]; then
    if ! "${CANON}/customizations/apply-floyd-branding.sh"; then
        echo "[omf] branding guard failed — preserving last verified runtime binary"
        CANON_READY=0
    elif ! grep -aq "FloydsLabs.com" "${CANON_BIN}"; then
        echo "[omf] branding marker missing — preserving last verified runtime binary"
        CANON_READY=0
    elif ! PATCH_RESULT=$("${HERE}/../../../scripts/apply-omf-vault-routing-patch.sh" "${CANON}"); then
        echo "[omf] Vault provider-tool patch failed — preserving last verified runtime binary"
        CANON_READY=0
    else
        print -r -- "${PATCH_RESULT}"
        if [[ "${PATCH_RESULT}" == *"OMF_VAULT_PATCH_CHANGED=1"* ]]; then
            if ! (cd "${CANON}/packages/coding-agent" && bun run build); then
                echo "[omf] Vault routing rebuild failed — preserving last verified runtime binary"
                CANON_READY=0
            fi
        fi
    fi
fi

if [ "${CANON_READY}" -eq 1 ] \
    && [ -f "${CANON_BIN}" ] \
    && ! grep -aq "FloydsLabs.com" "${CANON_BIN}"; then
    echo "[omf] rebuilt branding marker missing — preserving last verified runtime binary"
    CANON_READY=0
fi

if [ "${CANON_READY}" -eq 1 ] \
    && [ -f "${CANON_BIN}" ] \
    && ! cmp -s "${CANON_BIN}" "${COPY_BIN}"; then
    mkdir -p "${HERE}/bin"
    CANDIDATE="${COPY_BIN}.candidate.$$"
    if cp "${CANON_BIN}" "${CANDIDATE}" \
        && chmod 755 "${CANDIDATE}" \
        && node "${VERIFY_TOOLS}" "${CANDIDATE}"; then
        mv "${CANDIDATE}" "${COPY_BIN}"
        echo "[omf] runtime copy refreshed from verified canonical"
    else
        rm -f "${CANDIDATE}"
        echo "[omf] canonical candidate failed Vault verification — preserving last verified runtime binary"
    fi
fi

[ -x "${COPY_BIN}" ] || { echo "[omf] ERROR: no runtime binary at ${COPY_BIN}"; exec /bin/zsh; }
node "${VERIFY_TOOLS}" --fail-closed-only "${COPY_BIN}" || {
    echo "[omf] ERROR: shipped OMF binary lacks required fail-closed Vault routing"
    exec /bin/zsh
}
RUNTIME_ROOT="${FLOYD_RUNTIME_ROOT:-$HOME/.floyd}"
PROFILE="${FLOYD_VAULT_APP_PROFILE:-${RUNTIME_ROOT}/secrets/proxy-app-profiles/omf.json}"
SOURCE_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
MANAGED_AGENT_DIR="${RUNTIME_ROOT}/client-config/omf"
if [ -f "${SOURCE_AGENT_DIR}/agent.db" ]; then
    node "${HERE}/../../../scripts/lock-omf-credential-store.mjs" \
        --require-empty "${SOURCE_AGENT_DIR}/agent.db" || {
        echo "[omf] ERROR: direct credential state requires recoverable Vault migration"
        exec /bin/zsh
    }
fi
node "${HERE}/../../../scripts/materialize-vault-client-config.mjs" \
    omf "${PROFILE}" "${SOURCE_AGENT_DIR}" "${MANAGED_AGENT_DIR}" || {
    echo "[omf] ERROR: Vault unavailable; refusing direct-provider fallback"
    exec /bin/zsh
}
export PI_CODING_AGENT_DIR="${MANAGED_AGENT_DIR}"
POLICY="${MANAGED_AGENT_DIR}/vault-policy.yml"
# Provider commands and built-in provider tools stay available. The runner
# makes Vault win over inherited env and any --api-key value, points OMF's
# native auth-broker client at Vault, and applies the managed policy last.
exec node "${HERE}/../../../scripts/run-omf-with-vault.mjs" \
    "${PROFILE}" "${COPY_BIN}" "${POLICY}" "$@"
