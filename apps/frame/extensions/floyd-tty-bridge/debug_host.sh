#!/bin/bash
# Debug wrapper for Floyd TTY Bridge Native Host
exec 2> /tmp/floyd_native_debug.log
echo "Started at $(date)" >&2
echo "Environment: $(env)" >&2
/usr/bin/python3 "/Volumes/Storage/Floyd TTY Bridge for Chrome/extension/native_host.py" "$@" 2>> /tmp/floyd_native_debug.log
echo "Exited at $(date) with code $?" >&2
