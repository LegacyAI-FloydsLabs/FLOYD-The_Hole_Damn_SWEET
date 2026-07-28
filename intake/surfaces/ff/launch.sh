#!/bin/zsh
# FF plane launcher — the frame execs this as the TerminalOne SHELL.
# Runtime copy is ONLY the compiled binary (bin/floyd-ff-real); canonical is
# /opt/homebrew/libexec/floyd-harnesses/floyd-ff-real (read-only from here).
# Replicates the /usr/local/bin/floyd wrapper's data-dir pinning.

# Canonical exists only on the dev machine; installed apps run the shipped copy.
SRC="/opt/homebrew/libexec/floyd-harnesses/floyd-ff-real"
HERE="${0:A:h}"
COPY_BIN="${HERE}/bin/floyd-ff-real"

if [ -f "${SRC}" ] && ! cmp -s "${SRC}" "${COPY_BIN}"; then
    echo "[ff] canonical binary differs; keeping the packaged, Vault-verified runtime copy"
fi

[ -x "${COPY_BIN}" ] || { echo "[ff] ERROR: no runtime binary at ${COPY_BIN}"; exec /bin/zsh; }

DATA_DIR="${FLOYD_DATA_DIR:-$HOME/.floyd-ff}"
mkdir -p "${DATA_DIR}" 2>/dev/null || true
RUNTIME_ROOT="${FLOYD_RUNTIME_ROOT:-$HOME/.floyd}"
PROFILE="${FLOYD_VAULT_APP_PROFILE:-${RUNTIME_ROOT}/secrets/proxy-app-profiles/ff.json}"
MANAGED_DATA="${RUNTIME_ROOT}/client-config/ff"
node "${HERE}/../../../scripts/materialize-vault-client-config.mjs" \
    ff "${PROFILE}" "${DATA_DIR}" "${MANAGED_DATA}" || {
    echo "[ff] ERROR: Vault unavailable; refusing direct-provider fallback"
    exec /bin/zsh
}
export FLOYD_GLOBAL_DATA="${MANAGED_DATA}"
for a in "$@"; do
    case "$a" in
        login)
            exec node "${HERE}/../../../scripts/vault-provider-handoff.mjs" ff login
            ;;
        update-providers)
            exec node "${HERE}/../../../scripts/update-floyd-providers-with-vault.mjs" \
                ff "${PROFILE}" "${COPY_BIN}" "${MANAGED_DATA}" "$@"
            ;;
        -D|-D=*|--data-dir|--data-dir=*)
            echo "[ff] ERROR: alternate data-dir controls can bypass the managed Vault configuration"
            exit 64
            ;;
    esac
done
mkdir -p "${MANAGED_DATA}/data"
exec node "${HERE}/../../../scripts/run-with-vault-environment.mjs" \
    ff "${PROFILE}" "${COPY_BIN}" -D "${MANAGED_DATA}/data" "$@"
