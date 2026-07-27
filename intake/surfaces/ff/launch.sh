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
    mkdir -p "${HERE}/bin"
    cp "${SRC}" "${COPY_BIN}.tmp" && mv "${COPY_BIN}.tmp" "${COPY_BIN}" && chmod 755 "${COPY_BIN}"
    echo "[ff] runtime copy refreshed from canonical"
fi

[ -x "${COPY_BIN}" ] || { echo "[ff] ERROR: no runtime binary at ${COPY_BIN}"; exec /bin/zsh; }

DATA_DIR="${FLOYD_DATA_DIR:-$HOME/.floyd-ff}"
mkdir -p "${DATA_DIR}" 2>/dev/null || true
for a in "$@"; do
    case "$a" in
        -D|-D=*|--data-dir|--data-dir=*) exec "${COPY_BIN}" "$@" ;;
    esac
done
exec "${COPY_BIN}" -D "${DATA_DIR}" "$@"
