#!/usr/bin/env python3
"""Objective 4 (CI-runnable sub-tests) — com.floyd.core launchd plist validation.

Sub-test 1: plist is well-formed and has Label, KeepAlive, RunAtLoad, a real
            executable path, and log paths consistent with the auth-broker pattern.
(Sub-tests 2-4 require launchctl load + a live run; run via --live. Sub-test 5,
reboot survival, is a manual operator checklist item, not CI.)

Exit 0 = pass.
"""
import os, plistlib, subprocess, sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PLIST = os.environ.get("FLOYD_CORE_PLIST", os.path.expanduser("~/Library/LaunchAgents/com.floyd.core.plist"))
AUTH_BROKER = os.path.expanduser("~/Library/LaunchAgents/com.omp.auth-broker.plist")

def main():
    checks = {}
    # 1a: parses as a plist
    try:
        with open(PLIST, "rb") as f:
            p = plistlib.load(f)
        checks["1a plist parses"] = True
    except Exception as e:
        print("FAIL 1a plist parses:", e)
        sys.exit(1)

    checks["1b Label == com.floyd.core"] = p.get("Label") == "com.floyd.core"
    checks["1c KeepAlive true"] = p.get("KeepAlive") is True
    checks["1d RunAtLoad true"] = p.get("RunAtLoad") is True
    checks["1e Umask is private 077"] = p.get("Umask") == 0o77

    args = p.get("ProgramArguments", [])
    exe = args[0] if args else ""
    script = args[1] if len(args) > 1 else ""
    checks["1f executable exists"] = bool(exe) and os.path.exists(exe)
    checks["1g core entrypoint is a real main.ts"] = script.endswith("core/daemon/src/main.ts") and os.path.exists(script)
    checks["1h working directory exists"] = bool(p.get("WorkingDirectory")) and os.path.isdir(p.get("WorkingDirectory"))
    checks["1i StandardOutPath set"] = bool(p.get("StandardOutPath"))
    checks["1j StandardErrorPath set"] = bool(p.get("StandardErrorPath"))

    # consistency with the auth-broker pattern (same keys present), if available
    if os.path.exists(AUTH_BROKER):
        with open(AUTH_BROKER, "rb") as f:
            ab = plistlib.load(f)
        pattern_keys = {"Label", "KeepAlive", "RunAtLoad", "ProgramArguments", "StandardOutPath", "StandardErrorPath"}
        checks["1k matches auth-broker key pattern"] = pattern_keys.issubset(p.keys()) and pattern_keys.issubset(ab.keys())
    else:
        checks["1k matches auth-broker key pattern"] = {"Label","KeepAlive","RunAtLoad","ProgramArguments"}.issubset(p.keys())

    # plutil lint as an independent structural check
    r = subprocess.run(["/usr/bin/plutil", "-lint", PLIST], capture_output=True, text=True)
    checks["1l plutil lint OK"] = r.returncode == 0

    print("=== OBJECTIVE 4 PLIST VALIDATION ===")
    for k, v in checks.items():
        print(("PASS " if v else "FAIL ") + k)
    ok = all(checks.values())
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)

main()
