import { spawnSync } from "node:child_process";

const GIT = "/usr/bin/git";

export interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync(GIT, args, { cwd, encoding: "utf8", timeout: 60000 });
  return { ok: r.status === 0, code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function gitOrThrow(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.slice(0, 400)}`);
  return r.stdout;
}

export function addWorktree(repoPath: string, worktreePath: string, branch: string): void {
  gitOrThrow(repoPath, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  git(repoPath, ["worktree", "remove", "--force", worktreePath]);
}

export function headSha(repoPath: string): string {
  return gitOrThrow(repoPath, ["rev-parse", "HEAD"]).trim();
}

/** Diff vs the recorded base commit: covers committed, staged, unstaged, and untracked work. */
export function worktreeDiff(worktreePath: string, baseSha: string): string {
  git(worktreePath, ["add", "-A", "--intent-to-add"]);
  return git(worktreePath, ["diff", baseSha]).stdout;
}
