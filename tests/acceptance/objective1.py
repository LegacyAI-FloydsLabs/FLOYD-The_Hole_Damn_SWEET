#!/usr/bin/env python3
"""Objective 1 acceptance — bidirectional session channel (binary, repeatable).

Sub-tests (all must pass):
  1. SSE stream shows token, tool_call_start, tool_call_finish, question, permission
  2. mid-run steer is reflected in the run's output
  3. answering a question via the steer endpoint continues the run
  4. granting a permission via the steer endpoint continues the run
  5. reconnect with Last-Event-ID replays missed events in order

Stdlib only. Exit 0 = pass, 1 = fail. Prints a receipt block.
"""
import json, os, subprocess, sys, threading, time, urllib.request
NONCE = str(int(time.time()))

CORE = "http://127.0.0.1:41414"
RUNTIME = os.environ.get("FLOYD_RUNTIME_ROOT", "/Volumes/Storage/FLOYD_RUNTIME")
TOKEN = open(f"{RUNTIME}/core/gateway.token").read().strip()
HDR = {"authorization": f"Bearer {TOKEN}", "content-type": "application/json"}
EXTERNAL_PROBE = "/private/tmp/floyd-objective1-note.txt"

def api(method, path, body=None):
    req = urllib.request.Request(CORE + path, method=method, headers=HDR,
                                 data=json.dumps(body).encode() if body else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "{}")

def main():
    if os.path.exists(EXTERNAL_PROBE):
        os.unlink(EXTERNAL_PROBE)

    state = api("GET", "/api/state")
    project = state["projects"][0]["id"]
    session = state["sessions"][0]["id"]

    # --- attach SSE (curl subprocess; lines parsed live) ---
    events, seqs, lock = [], [], threading.Lock()
    seen_types = set()
    proc = subprocess.Popen(
        ["/usr/bin/curl", "-sN", "-H", f"authorization: Bearer {TOKEN}",
         f"{CORE}/api/sessions/{session}/events"],
        stdout=subprocess.PIPE, text=True)

    def reader():
        cur_id, cur_event = None, None
        for line in proc.stdout:
            line = line.rstrip("\n")
            if line.startswith("id:"): cur_id = int(line[3:].strip())
            elif line.startswith("event:"): cur_event = line[6:].strip()
            elif line.startswith("data:") and cur_event and cur_event != "hello":
                try: data = json.loads(line[5:].strip())
                except Exception: continue
                with lock:
                    events.append((cur_id, cur_event, data))
                    if cur_id: seqs.append(cur_id)
                    seen_types.add(cur_event)
    threading.Thread(target=reader, daemon=True).start()

    # --- submit the choreographed run ---
    goal = ("Before writing any code, use your question tool to ask me ONE question: "
            "'Which function name should I use?' with options scale and rescale, then wait for my answer. "
            "Implement the chosen function in src/calc.js multiplying every element of an array by a factor, with tests. "
            f"After tests pass, write a one-line completion note to {EXTERNAL_PROBE} "
            "(outside your directory — attempt it and proceed if permitted). Run node --test until all tests pass. [test-nonce " + NONCE + "]")
    run = api("POST", "/api/runs", {"project_id": project, "goal": goal})
    run_id = run["run_id"]
    print(f"[accept] run: {run_id}")

    answered_q = granted_p = steered = False
    deadline = time.time() + 720
    while time.time() < deadline:
        time.sleep(2)
        with lock:
            evs = list(events)
        # sub-test 3: answer the question
        if not answered_q:
            for _, et, d in evs:
                if et == "question":
                    rid = (d.get("data") or {}).get("id") or (d.get("data") or {}).get("requestID")
                    if rid:
                        api("POST", f"/api/sessions/{session}/steer",
                            {"type": "answer", "request_id": rid, "answers": [["scale"]], "actor": "acceptance-test"})
                        answered_q = True
                        print(f"[accept] answered question {rid} -> scale")
                        break
        # sub-test 2: steer once, after the question is answered
        if answered_q and not steered:
            api("POST", f"/api/sessions/{session}/steer",
                {"type": "steer", "text": "Steering update: also add a test that scale([2], 0) returns [0].",
                 "actor": "acceptance-test"})
            steered = True
            print("[accept] steer sent")
        # sub-test 4: grant the external-directory permission
        if not granted_p:
            for _, et, d in evs:
                if et == "permission":
                    rid = (d.get("data") or {}).get("id") or (d.get("data") or {}).get("requestID")
                    if rid:
                        api("POST", f"/api/sessions/{session}/steer",
                            {"type": "permission", "request_id": rid, "reply": "once", "actor": "acceptance-test"})
                        granted_p = True
                        print(f"[accept] granted permission {rid}")
                        break
        status = api("GET", f"/api/runs/{run_id}")["status"]
        if status in ("waiting_review", "failed", "interrupted"):
            print(f"[accept] run terminal: {status}")
            break

    proc.terminate()

    # --- sub-test 5: replay with Last-Event-ID ---
    with lock:
        mid = seqs[len(seqs) // 2] if seqs else 0
        expected_after = [s for s in seqs if s > mid]
    replay = subprocess.run(
        ["/usr/bin/curl", "-sN", "-m", "4", "-H", f"authorization: Bearer {TOKEN}",
         "-H", f"Last-Event-ID: {mid}", f"{CORE}/api/sessions/{session}/events"],
        capture_output=True, text=True)
    replay_seqs = [int(l[3:].strip()) for l in replay.stdout.splitlines() if l.startswith("id:")]
    replay_ok = (replay_seqs[: len(expected_after)] == expected_after and
                 replay_seqs == sorted(replay_seqs) and len(replay_seqs) >= len(expected_after))

    # --- verdicts ---
    diff = ""
    try:
        req = urllib.request.Request(f"{CORE}/api/runs/{run_id}/artifact/diff", headers=HDR)
        diff = urllib.request.urlopen(req, timeout=15).read().decode()
    except Exception:
        pass
    checks = {
        "1a stream token": "token" in seen_types,
        "1b stream tool_call_start": "tool_call_start" in seen_types,
        "1c stream tool_call_finish": "tool_call_finish" in seen_types,
        "1d stream question": "question" in seen_types,
        "1e stream permission": "permission" in seen_types,
        "2 steer reflected (scale([2], 0) test in diff)": "scale([2], 0)" in diff or "scale([2],0)" in diff,
        "3 question answered, run continued (scale chosen)": answered_q and "function scale" in diff,
        "4 permission granted, external note written": granted_p and os.path.exists(EXTERNAL_PROBE),
        "5 Last-Event-ID replay in order": replay_ok,
    }
    print("\n=== OBJECTIVE 1 ACCEPTANCE ===")
    for k, v in checks.items():
        print(("PASS " if v else "FAIL ") + k)
    print(f"seqs observed: {len(seqs)} | replay from {mid}: {len(replay_seqs)} frames")
    ok = all(checks.values())
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)

main()
