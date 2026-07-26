#!/usr/bin/env python3
"""FLOYD chrono daemon — idle detection, autosave, and app reaping.

Best-practice lifecycle for the frame's managed apps:
  * start nothing eagerly (frame handles lazy launch)
  * kill nothing on surface switch (iframes keep state)
  * reap only when truly idle: no frame heartbeat AND no live TCP peers
    on the app port for IDLE_SECONDS. Before stopping, autosave the
    surface's git repo so no work is ever lost (linear micro-snapshot).

Stdlib only. No pip. Safe-by-default:
  * if the heartbeat file does not exist (older frame server), the daemon
    only logs and never reaps.
  * an app with any ESTABLISHED TCP peer on its port is never reaped.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass

WORKSTATION = "/Volumes/Storage/FLOYD_WORKSTATION"
SURFACES = os.path.join(WORKSTATION, "intake", "surfaces")
HEARTBEAT_FILE = os.path.join(WORKSTATION, "apps", "frame", "server", "heartbeat.json")
LOG_FILE = os.path.expanduser("~/Library/Logs/floyd/chrono.log")

IDLE_SECONDS = 5 * 60          # reap after 5 minutes of no heartbeat + no peers
POLL_SECONDS = 60              # check cadence
AUTOSAVE_PREFIX = "chrono: autosave"

# app id -> (port, git repo dir for autosave)
APPS: dict[str, tuple[int, str]] = {
    "cursem-ide": (13012, os.path.join(SURFACES, "ide")),
    "floyd-desktop": (13010, os.path.join(SURFACES, "desktop")),
    "harness-launcher": (13014, os.path.join(SURFACES, "launcher")),
    "floyd-code-cli": (13022, os.path.join(SURFACES, "pty")),
    "ohmyfloyd": (13023, os.path.join(SURFACES, "pty")),
    "terminalone": (13013, os.path.join(SURFACES, "pty")),
}


def run(cmd: list[str], cwd: str | None = None, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def listening_pid(port: int) -> int | None:
    out = run(["lsof", "-nP", "-ti", f"tcp:{port}", "-sTCP:LISTEN"]).stdout.strip()
    return int(out.splitlines()[0]) if out else None


def established_peers(port: int) -> int:
    out = run(["lsof", "-nP", "-i", f"tcp:{port}", "-sTCP:ESTABLISHED"]).stdout
    # header line + one line per socket end; any line means a live peer
    lines = [l for l in out.splitlines() if l and not l.startswith("COMMAND")]
    return len(lines)


def heartbeat_age_for(app_id: str) -> float | None:
    """Seconds since the frame UI last reported this app's iframe open.

    Returns None when unknown (no heartbeat file yet) — treated as NOT idle.
    """
    try:
        with open(HEARTBEAT_FILE, encoding="utf-8") as fh:
            hb = json.load(fh)
    except (OSError, ValueError):
        return None
    ts = hb.get("ts")
    apps = hb.get("apps", [])
    if not isinstance(ts, (int, float)):
        return None
    age = time.time() - ts / 1000.0
    # iframe open in a live frame session -> fresh heartbeat lists the app
    if app_id in apps and age < IDLE_SECONDS:
        return 0.0
    return age


def autosave(repo: str, app_id: str) -> str:
    """Shadow micro-snapshot before stopping. Never commits to the branch and
    never bypasses hooks — snapshots land on refs/chrono/snapshots via the
    chrono sandbox (Proofline-compliant: plumbing only, no branch mutation)."""
    if not os.path.isdir(os.path.join(repo, ".git")):
        return "no-git"
    msg = f"{AUTOSAVE_PREFIX} ({app_id} idle) {time.strftime('%Y-%m-%dT%H:%M:%S')}"
    cli = os.path.join(WORKSTATION, "ops", "chrono", "chrono_sandbox.py")
    r = run([sys.executable, cli, repo, "snapshot", "-m", msg], timeout=60)
    if r.returncode != 0:
        return f"snapshot-failed: {r.stderr.strip()[:200]}"
    try:
        out = json.loads(r.stdout)
        return "snapshotted" if out.get("snapshot") else "clean"
    except ValueError:
        return f"snapshot-unparsed: {r.stdout.strip()[:120]}"


@dataclass
class IdleTracker:
    since: dict[str, float]

    def mark_active(self, app_id: str) -> None:
        self.since.pop(app_id, None)

    def idle_for(self, app_id: str, now: float) -> float:
        return now - self.since.setdefault(app_id, now)


def main() -> None:
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    logging.basicConfig(
        filename=LOG_FILE,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    logging.info("chrono daemon up (idle=%ss poll=%ss)", IDLE_SECONDS, POLL_SECONDS)
    tracker = IdleTracker(since={})

    while True:
        now = time.time()
        for app_id, (port, repo) in APPS.items():
            pid = listening_pid(port)
            if pid is None:
                tracker.mark_active(app_id)  # not running -> nothing to reap
                continue

            peers = established_peers(port)
            hb_age = heartbeat_age_for(app_id)

            # Active if anyone is connected, or the frame says the iframe is open,
            # or we cannot know (no heartbeat file -> never reap blindly).
            if peers > 0 or hb_age is None or hb_age == 0.0:
                tracker.mark_active(app_id)
                continue

            idle = tracker.idle_for(app_id, now)
            if idle < IDLE_SECONDS:
                continue

            save = autosave(repo, app_id)
            try:
                os.kill(pid, signal.SIGTERM)
                logging.info(
                    "reaped %s (port=%s pid=%s idle=%.0fs autosave=%s)",
                    app_id, port, pid, idle, save,
                )
            except OSError as err:
                logging.warning("failed to stop %s pid=%s: %s", app_id, pid, err)
            tracker.mark_active(app_id)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
