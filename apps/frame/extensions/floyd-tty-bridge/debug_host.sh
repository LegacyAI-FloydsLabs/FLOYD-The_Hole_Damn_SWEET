#!/bin/bash
# Debug wrapper for Floyd TTY Bridge Native Host
exec 2> /tmp/floyd_native_debug.log
echo "Started at $(date)" >&2
echo "Environment: $(env)" >&2
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
/usr/bin/python3 "$HERE/native_host.py" "$@" 2>> /tmp/floyd_native_debug.log
echo "Exited at $(date) with code $?" >&2
