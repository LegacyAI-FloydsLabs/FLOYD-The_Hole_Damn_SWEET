#!/bin/zsh
# OMF plane launcher — the frame execs this as the TerminalOne SHELL.
# The monorepo runtime copy is ONLY the compiled binary (bin/omp); the
# canonical app (source, build toolchain, branding guard) lives at
# /Volumes/SanDisk1Tb/OhMyFloyd and is where updates land.
#
# On load: 1) canonical self-heals its Floyd branding (rebuild only if an
# update wiped it), 2) refresh this copy's binary if the canonical changed,
# 3) exec the copy. The canonical is only ever READ from here.

# Canonical exists only on the dev machine; installed apps run the shipped copy.
CANON="/Volumes/SanDisk1Tb/OhMyFloyd"
CANON_BIN="${CANON}/packages/coding-agent/dist/omp"
HERE="${0:A:h}"
COPY_BIN="${HERE}/bin/omp"

if [ -d "${CANON}" ]; then
    "${CANON}/customizations/apply-floyd-branding.sh" ||
        echo "[omf] branding guard failed — continuing with last good binary"
fi

if [ -f "${CANON_BIN}" ] && ! cmp -s "${CANON_BIN}" "${COPY_BIN}"; then
    mkdir -p "${HERE}/bin"
    cp "${CANON_BIN}" "${COPY_BIN}.tmp" && mv "${COPY_BIN}.tmp" "${COPY_BIN}" && chmod 755 "${COPY_BIN}"
    echo "[omf] runtime copy refreshed from canonical"
fi

[ -x "${COPY_BIN}" ] || { echo "[omf] ERROR: no runtime binary at ${COPY_BIN}"; exec /bin/zsh; }
exec "${COPY_BIN}" "$@"
