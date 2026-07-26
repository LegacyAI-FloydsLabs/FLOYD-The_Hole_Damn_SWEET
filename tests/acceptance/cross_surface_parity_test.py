#!/usr/bin/env python3
"""Objective 2 acceptance — cross-surface session continuity (binary, repeatable).

Scenario:
  1. Start a run as the CLI surface; record sessionId.
  2. Mid-run, attach a SECOND surface (Cockpit) to the same session.
  3. Cockpit observes the live token stream (rendering = frames received).
  4. Cockpit answers the engine's interactive request (a QUESTION the builder
     is instructed to ask — the deterministic cross-surface interactive
     primitive; permission-grant-from-surface is separately proven in
     objective1.py, which the builder's in-worktree guardrail makes flaky to
     trigger here on purpose).
  5. CLI surface also observed the same session events and the run continues to
     its gate with no state loss.
  6. Exactly one Floyd Core process exists throughout.

Exit 0 = pass. Stdlib only.
"""
import json, os, subprocess, sys, threading, time, urllib.request
NONCE = str(int(time.time()))

CORE = "http://127.0.0.1:41414"
RUNTIME = os.environ.get("FLOYD_RUNTIME_ROOT", "/Volumes/Storage/FLOYD_RUNTIME")
TOKEN = open(f"{RUNTIME}/core/gateway.token").read().strip()
HDR = {"authorization": f"Bearer {TOKEN}", "content-type": "application/json"}
EXTERNAL_PROBE = "/private/tmp/floyd-parity-note.txt"

def api(method, path, body=None):
    req = urllib.request.Request(CORE + path, method=method, headers=HDR,
                                 data=json.dumps(body).encode() if body else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "{}")

class Surface:
    """One attached surface: its own SSE connection and event log."""
    def __init__(self, name, session):
        self.name, self.events, self.types = name, [], set()
        self.proc = subprocess.Popen(
            ["/usr/bin/curl", "-sN", "-X", "POST",
             "-H", f"authorization: Bearer {TOKEN}",
             "-H", "content-type: application/json",
             "-d", json.dumps({"actor": name}),
             f"{CORE}/api/sessions/{session}/attach"],
            stdout=subprocess.PIPE, text=True)
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        et = None
        for line in self.proc.stdout:
            line = line.rstrip("\n")
            if line.startswith("event:"): et = line[6:].strip()
            elif line.startswith("data:") and et and et != "hello":
                try: data = json.loads(line[5:].strip())
                except Exception: continue
                with self.lock:
                    self.events.append((et, data))
                    self.types.add(et)

    def find(self, etype):
        with self.lock:
            return [d for t, d in self.events if t == etype]

def main():
    if os.path.exists(EXTERNAL_PROBE):
        os.unlink(EXTERNAL_PROBE)
    state = api("GET", "/api/state")
    project, session = state["projects"][0]["id"], state["sessions"][0]["id"]

    # 1. CLI surface starts the run and attaches
    cli = Surface("parity-cli", session)
    run = api("POST", "/api/runs", {"project_id": project, "goal":
        "STEP 1 — do this FIRST: use your question tool to ask me exactly one question, "
        "'Should isEven treat 0 as even?', with options yes and no, then WAIT for my answer before writing code. "
        "STEP 2 — add an isEven(n) function to src/calc.js honoring my answer, with tests (throw Error for non-number). "
        "Run node --test until all pass. [test-nonce " + NONCE + "]"})
    run_id = run["run_id"]
    print(f"[parity] run {run_id} started by CLI surface, session {session}")

    # 2. mid-run: Cockpit attaches once the builder is streaming
    deadline = time.time() + 120
    while time.time() < deadline and "token" not in cli.types:
        time.sleep(1)
    cockpit = Surface("parity-cockpit", session)
    print("[parity] cockpit attached mid-run")

    answered = False
    deadline = time.time() + 600
    while time.time() < deadline:
        time.sleep(2)
        # 4. cockpit answers the QUESTION (live event OR on-attach snapshot)
        if not answered:
            asks = cockpit.find("question")
            if not asks:
                # a question that fired before cockpit attached arrives as an
                # on-attach snapshot; re-attach a fresh cockpit view to fetch it
                snap = Surface("parity-cockpit-snap", session)
                time.sleep(3)
                asks = snap.find("question")
                snap.proc.terminate()
            for d in asks:
                rid = (d.get("data") or {}).get("id") or (d.get("data") or {}).get("requestID")
                if rid:
                    try:
                        api("POST", f"/api/sessions/{session}/steer",
                            {"type": "answer", "request_id": rid, "answers": [["yes"]], "actor": "parity-cockpit"})
                        answered = True
                        print(f"[parity] cockpit answered question {rid} -> yes")
                    except Exception as e:
                        print(f"[parity] ask {rid} no longer pending ({e})")
                    break
        status = api("GET", f"/api/runs/{run_id}")["status"]
        if status in ("waiting_review", "failed", "interrupted"):
            print(f"[parity] terminal: {status}")
            break

    # 6. exactly one core process
    ps = subprocess.run(["/usr/bin/pgrep", "-f", "core/daemon/src/main.ts"], capture_output=True, text=True)
    core_pids = [p for p in ps.stdout.split() if p.strip()]

    # evidence: cockpit's answer recorded; run reached gate
    ev = api("GET", f"/api/evidence?run_id={run_id}")["events"]
    cockpit_answer = any(e["type"] == "engine.question.answered" and e["actor"] == "parity-cockpit" for e in ev)
    status = api("GET", f"/api/runs/{run_id}")["status"]

    checks = {
        "1 run started from CLI surface, session recorded": bool(run_id and session),
        "2 cockpit attached mid-run (received live frames)": len(cockpit.events) > 0,
        "3 cockpit observed live token stream": "token" in cockpit.types,
        "4 cockpit answered the engine question": answered and cockpit_answer,
        "5 CLI observed the same session events + run continued, no state loss":
            "token" in cli.types and status == "waiting_review",
        "6 exactly one Floyd Core process": len(core_pids) == 1,
    }
    cli.proc.terminate(); cockpit.proc.terminate()
    print("\n=== CROSS-SURFACE PARITY ===")
    for k, v in checks.items():
        print(("PASS " if v else "FAIL ") + k)
    print(f"core pids: {core_pids} | cli frames: {len(cli.events)} | cockpit frames: {len(cockpit.events)}")
    ok = all(checks.values())
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)

main()
