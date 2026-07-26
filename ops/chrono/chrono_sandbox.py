#!/usr/bin/env python3
"""FLOYD chrono sandbox — time-manipulation controller for agent workspaces.

Bare-metal git + APFS primitives, stdlib only. Implements:

  * micro-snapshot   — shadow-ref snapshot (refs/chrono/snapshots): T-1 recovery
                       point per tool call. Never touches the branch, HEAD, index,
                       hooks, or `git log` (Claude-style shadow checkpoints).
  * timeline         — list shadow snapshots (rewind targets)
  * rewind           — restore working tree from any snapshot/ref; HEAD unmoved;
                       always takes a pre-rewind safety snapshot first
  * fork             — chrono-forking: N parallel worktrees off one commit
  * forks            — list live forks with dirty/diff state
  * diff             — inspect one fork's diff vs its base (for ensemble voting)
  * merge-winner     — commit winning fork into main, prune losing timelines
  * prune            — remove a fork (or all forks) without merging
  * clone            — zero-copy APFS clonefile of any directory (cp -c)
  * ledger           — JSON execution ledger of every sandbox operation

Usage:
  chrono_sandbox.py <repo> snapshot [-m MSG]
  chrono_sandbox.py <repo> timeline [-n N]
  chrono_sandbox.py <repo> rewind [--to REF] [--hard]
  chrono_sandbox.py <repo> fork NAME [NAME ...] [--base REF]
  chrono_sandbox.py <repo> forks
  chrono_sandbox.py <repo> diff NAME
  chrono_sandbox.py <repo> merge-winner NAME
  chrono_sandbox.py <repo> prune [NAME | --all]
  chrono_sandbox.py <repo> clone SRC DST
  chrono_sandbox.py <repo> ledger [-n N]

All output is JSON on stdout so any surface (MCP tool, terminal, frame UI)
can consume it directly.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

FORK_PREFIX = "chrono/"
SHADOW_REF = "refs/chrono/snapshots"


def fail(msg: str) -> "None":
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


class Sandbox:
    def __init__(self, repo: str):
        self.repo = os.path.abspath(repo)
        if not os.path.isdir(os.path.join(self.repo, ".git")):
            fail(f"not a git repo: {self.repo}")
        self.fork_root = os.path.join(self.repo, ".chrono", "forks")
        self.ledger_path = os.path.join(self.repo, ".chrono", "ledger.jsonl")
        os.makedirs(os.path.dirname(self.ledger_path), exist_ok=True)
        self._ensure_ignored()

    # ---- plumbing ----------------------------------------------------------
    def git(self, *args: str, cwd: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
        r = subprocess.run(["git", *args], cwd=cwd or self.repo, capture_output=True, text=True)
        if check and r.returncode != 0:
            fail(f"git {' '.join(args)}: {r.stderr.strip()}")
        return r

    def _ensure_ignored(self) -> None:
        """Keep .chrono/ out of history without touching tracked .gitignore."""
        exclude = os.path.join(self.repo, ".git", "info", "exclude")
        try:
            with open(exclude, encoding="utf-8") as fh:
                if ".chrono/" in fh.read():
                    return
        except OSError:
            pass
        with open(exclude, "a", encoding="utf-8") as fh:
            fh.write("\n.chrono/\n")

    def record(self, op: str, **details) -> None:
        entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "op": op, **details}
        with open(self.ledger_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")

    def head(self, cwd: str | None = None) -> str:
        return self.git("rev-parse", "HEAD", cwd=cwd).stdout.strip()

    def dirty(self, cwd: str | None = None) -> bool:
        return bool(self.git("status", "--porcelain", cwd=cwd).stdout.strip())

    # ---- shadow-ref plumbing ----------------------------------------------
    # Snapshots live under refs/chrono/snapshots: real commit objects in the
    # app's own object database, but on a hidden ref. The branch, `git log`,
    # `git status`, pushes, and hooks never see them (Claude-style shadow
    # checkpoints). A throwaway index file keeps the user's staging area
    # untouched.
    def _tmp_index(self) -> str:
        return os.path.join(self.repo, ".git", "chrono-index")

    def _git_shadow(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        env = dict(os.environ, GIT_INDEX_FILE=self._tmp_index())
        r = subprocess.run(["git", *args], cwd=self.repo, capture_output=True, text=True, env=env)
        if check and r.returncode != 0:
            fail(f"git {' '.join(args)}: {r.stderr.strip()}")
        return r

    def shadow_tip(self) -> str | None:
        r = self.git("rev-parse", "--verify", "--quiet", SHADOW_REF, check=False)
        return r.stdout.strip() or None

    def _head_or_none(self) -> str | None:
        r = self.git("rev-parse", "--verify", "--quiet", "HEAD", check=False)
        return r.stdout.strip() or None

    # ---- linear time -------------------------------------------------------
    def snapshot(self, message: str | None = None) -> dict:
        """Shadow snapshot: capture the entire working tree (tracked + untracked,
        excludes respected) as a commit on refs/chrono/snapshots. The branch,
        HEAD, and the user's index are never touched."""
        tmp = self._tmp_index()
        if os.path.exists(tmp):
            os.remove(tmp)
        # Build a fresh index of the full current working state.
        self._git_shadow("add", "-A")
        tree = self._git_shadow("write-tree").stdout.strip()
        tip = self.shadow_tip()
        if tip:
            prev_tree = self.git("rev-parse", f"{tip}^{{tree}}").stdout.strip()
            if prev_tree == tree:
                return {"ok": True, "snapshot": None, "tip": tip,
                        "note": "no changes since last snapshot"}
        msg = message or f"chrono: micro-snapshot {time.strftime('%Y-%m-%dT%H:%M:%S')}"
        base = self._head_or_none()
        full_msg = msg + (f"\n\nchrono-base: {base}" if base else "")
        args = ["commit-tree", tree, "-m", full_msg]
        if tip:
            args += ["-p", tip]
        sha = self.git(*args).stdout.strip()
        self.git("update-ref", SHADOW_REF, sha, tip or "")
        self.record("snapshot", sha=sha, message=msg)
        return {"ok": True, "snapshot": sha, "message": msg}

    def timeline(self, n: int = 15) -> dict:
        """List shadow snapshots newest-first (the rewind targets)."""
        tip = self.shadow_tip()
        if not tip:
            return {"ok": True, "commits": [], "note": "no snapshots yet"}
        r = self.git("log", f"--max-count={n}", "--pretty=format:%h|%H|%ad|%s",
                     "--date=format:%H:%M:%S", SHADOW_REF)
        commits = []
        for line in r.stdout.splitlines():
            sha, full, t, *rest = line.split("|")
            commits.append({"sha": sha, "full": full, "time": t, "subject": "|".join(rest)})
        return {"ok": True, "commits": commits}

    def rewind(self, to: str | None = None, hard: bool = False) -> dict:
        """Restore the working tree from a snapshot (shadow commit) or any ref.

        HEAD and the branch are never moved. Files are overwritten to match the
        snapshot; files that exist now but not in the snapshot are deleted
        (tracked-state restore). A pre-rewind safety snapshot is always taken
        first, so the rewind itself is undoable. `hard` is accepted for
        API compatibility; both modes are safe because of the pre-snapshot.
        """
        # Default target: the latest shadow snapshot.
        if not to:
            to = self.shadow_tip() or "HEAD~1"
        target = self.git("rev-parse", "--verify", f"{to}^{{commit}}").stdout.strip()
        # Safety net first — this rewind must itself be reversible.
        pre = self.snapshot("chrono: pre-rewind safety snapshot")
        pre_sha = pre.get("snapshot") or pre.get("tip") or self.shadow_tip()

        # Materialize the target state through the throwaway index so the
        # user's real index/staging area is untouched.
        tmp = self._tmp_index()
        if os.path.exists(tmp):
            os.remove(tmp)
        self._git_shadow("read-tree", target)
        self._git_shadow("checkout-index", "-a", "-f")
        # Delete files that exist now but are absent in the target snapshot
        # (otherwise a rewind can never remove a file). Untracked-in-both are
        # handled because snapshots capture untracked files too.
        now_files = set(self._git_shadow("ls-files").stdout.splitlines())
        if os.path.exists(tmp):
            os.remove(tmp)
        self._git_shadow("add", "-A")
        current = set(self._git_shadow("ls-files").stdout.splitlines())
        for path in sorted(current - now_files):
            fp = os.path.join(self.repo, path)
            if os.path.isfile(fp) or os.path.islink(fp):
                os.remove(fp)
        # Clean up emptied directories left behind by deletions.
        for path in sorted(current - now_files, reverse=True):
            d = os.path.dirname(os.path.join(self.repo, path))
            while d != self.repo:
                try:
                    os.rmdir(d)
                except OSError:
                    break
                d = os.path.dirname(d)
        if os.path.exists(tmp):
            os.remove(tmp)
        self.record("rewind", frm=pre_sha, to=target, hard=hard)
        return {"ok": True, "rewound_from": pre_sha, "now_at": target,
                "recovery_hint": f"chrono rewind --to {pre_sha}", "pre_snapshot": pre}

    # ---- branching time ----------------------------------------------------
    def fork(self, names: list[str], base: str | None = None) -> dict:
        base_sha = self.git("rev-parse", "--verify", base or "HEAD").stdout.strip()
        os.makedirs(self.fork_root, exist_ok=True)
        made = []
        for name in names:
            branch = FORK_PREFIX + name
            path = os.path.join(self.fork_root, name)
            if os.path.exists(path):
                fail(f"fork already exists: {name}")
            self.git("worktree", "add", "-b", branch, path, base_sha)
            made.append({"name": name, "branch": branch, "path": path, "base": base_sha})
        self.record("fork", base=base_sha, forks=[m["name"] for m in made])
        return {"ok": True, "base": base_sha, "forks": made}

    def list_forks(self) -> dict:
        forks = []
        if os.path.isdir(self.fork_root):
            for name in sorted(os.listdir(self.fork_root)):
                path = os.path.join(self.fork_root, name)
                if not os.path.isdir(os.path.join(path, ".git")) and not os.path.isfile(os.path.join(path, ".git")):
                    continue
                stat = self.git("diff", "--shortstat", "HEAD", cwd=path, check=False).stdout.strip()
                forks.append({"name": name, "path": path, "head": self.head(cwd=path),
                              "dirty": self.dirty(cwd=path), "diffstat": stat or "no changes"})
        return {"ok": True, "forks": forks}

    def diff(self, name: str) -> dict:
        path = os.path.join(self.fork_root, name)
        if not os.path.isdir(path):
            fail(f"no such fork: {name}")
        base = self.git("merge-base", "HEAD", FORK_PREFIX + name).stdout.strip()
        d = self.git("diff", base, cwd=path, check=False).stdout
        return {"ok": True, "name": name, "base": base, "diff": d}

    def merge_winner(self, name: str) -> dict:
        path = os.path.join(self.fork_root, name)
        branch = FORK_PREFIX + name
        if not os.path.isdir(path):
            fail(f"no such fork: {name}")
        # Commit any uncommitted work inside the winning fork first.
        if self.dirty(cwd=path):
            self.git("add", "-A", cwd=path)
            self.git("commit", "-m", f"chrono: finalize fork {name}", "--no-verify", cwd=path)
        # Shadow safety snapshot, then require a clean main tree: merge is a
        # real branch operation and must not silently mix in uncommitted work.
        pre = self.snapshot(f"chrono: pre-merge of {name}")
        if self.dirty():
            fail(f"main worktree has uncommitted changes; commit or stash them before merging fork {name} (a shadow snapshot was taken: {pre.get('snapshot') or pre.get('tip')})")
        r = self.git("merge", "--no-ff", branch, "-m", f"chrono: merge winner {name}", check=False)
        if r.returncode != 0:
            self.git("merge", "--abort", check=False)
            fail(f"merge conflict merging {name}; losing forks left intact: {r.stdout} {r.stderr}")
        losers = [f["name"] for f in self.list_forks()["forks"] if f["name"] != name]
        for loser in losers:
            self._remove_fork(loser)
        self._remove_fork(name)
        self.record("merge-winner", winner=name, pruned=losers, head=self.head())
        return {"ok": True, "merged": name, "pruned": losers, "head": self.head(), "pre_merge": pre}

    def _remove_fork(self, name: str) -> None:
        path = os.path.join(self.fork_root, name)
        self.git("worktree", "remove", "--force", path, check=False)
        self.git("branch", "-D", FORK_PREFIX + name, check=False)

    def prune(self, name: str | None, all_forks: bool) -> dict:
        targets = [f["name"] for f in self.list_forks()["forks"]] if all_forks else ([name] if name else [])
        if not targets:
            fail("specify a fork name or --all")
        for t in targets:
            self._remove_fork(t)
        self.record("prune", forks=targets)
        return {"ok": True, "pruned": targets}

    # ---- zero-copy ---------------------------------------------------------
    def clone(self, src: str, dst: str) -> dict:
        """APFS copy-on-write clone: instant, no extra storage until divergence."""
        if os.path.exists(dst):
            fail(f"destination exists: {dst}")
        r = subprocess.run(["cp", "-Rc", src, dst], capture_output=True, text=True)
        if r.returncode != 0:
            fail(f"clonefile failed: {r.stderr.strip()}")
        self.record("clone", src=src, dst=dst)
        return {"ok": True, "cloned": dst, "note": "APFS copy-on-write, zero storage cost until files diverge"}

    def ledger(self, n: int) -> dict:
        try:
            with open(self.ledger_path, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
        except OSError:
            lines = []
        return {"ok": True, "entries": [json.loads(l) for l in lines[-n:]]}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("repo", help="path to the surface git repo")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("snapshot"); s.add_argument("-m", "--message")
    r = sub.add_parser("rewind"); r.add_argument("--to", default=None); r.add_argument("--hard", action="store_true")
    tl = sub.add_parser("timeline"); tl.add_argument("-n", type=int, default=15)
    f = sub.add_parser("fork"); f.add_argument("names", nargs="+"); f.add_argument("--base")
    sub.add_parser("forks")
    d = sub.add_parser("diff"); d.add_argument("name")
    m = sub.add_parser("merge-winner"); m.add_argument("name")
    pr = sub.add_parser("prune"); pr.add_argument("name", nargs="?"); pr.add_argument("--all", action="store_true")
    c = sub.add_parser("clone"); c.add_argument("src"); c.add_argument("dst")
    lg = sub.add_parser("ledger"); lg.add_argument("-n", type=int, default=20)

    a = p.parse_args()
    sb = Sandbox(a.repo)
    out = {
        "snapshot": lambda: sb.snapshot(a.message),
        "rewind": lambda: sb.rewind(a.to, a.hard),
        "timeline": lambda: sb.timeline(a.n),
        "fork": lambda: sb.fork(a.names, a.base),
        "forks": lambda: sb.list_forks(),
        "diff": lambda: sb.diff(a.name),
        "merge-winner": lambda: sb.merge_winner(a.name),
        "prune": lambda: sb.prune(a.name, getattr(a, "all")),
        "clone": lambda: sb.clone(a.src, a.dst),
        "ledger": lambda: sb.ledger(a.n),
    }[a.cmd]()
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
