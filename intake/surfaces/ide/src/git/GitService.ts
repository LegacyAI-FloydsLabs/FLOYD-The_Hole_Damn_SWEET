// CURSE'M IDE — Git Service (§7).
//
// §7: "Use the real system Git through the Floyd backend—not isomorphic-git."
// §7 Required functions: status, branch/worktree awareness, file/line diffs,
//   stage/unstage, commit, fetch/pull, push with confirmation, branch
//   creation/switching, conflict display/resolution, commit history,
//   changed-file navigation.
// §7: "Git credentials must remain in the host credential system and never
//       be passed into browser JavaScript."
//
// All Git operations go through the HostGateway, which delegates to the
// real system Git on the Floyd backend. The IDE never runs Git in the browser.

import type { HostGateway, GitStatus, GitCommit, GitBranch, GitChangedFile } from '@/platform';

export class GitService {
  private gateway: HostGateway;

  constructor(gateway: HostGateway) {
    this.gateway = gateway;
  }

  async status(repoPath: string): Promise<GitStatus> {
    return this.gateway.gitStatus(repoPath);
  }

  async stage(repoPath: string, files: string[]): Promise<void> {
    return this.gateway.gitStage(repoPath, files);
  }

  async unstage(repoPath: string, files: string[]): Promise<void> {
    return this.gateway.gitUnstage(repoPath, files);
  }

  async commit(repoPath: string, message: string): Promise<void> {
    return this.gateway.gitCommit(repoPath, message);
  }

  async fetch(repoPath: string): Promise<void> {
    return this.gateway.gitFetch(repoPath);
  }

  async pull(repoPath: string): Promise<void> {
    return this.gateway.gitPull(repoPath);
  }

  /** §7: "push with confirmation" — the gateway handles confirmation. */
  async push(repoPath: string): Promise<void> {
    return this.gateway.gitPush(repoPath);
  }

  async createBranch(repoPath: string, name: string): Promise<void> {
    return this.gateway.gitBranch(repoPath, name);
  }

  async checkout(repoPath: string, branch: string): Promise<void> {
    return this.gateway.gitCheckout(repoPath, branch);
  }

  async diff(repoPath: string, file?: string): Promise<string> {
    return this.gateway.gitDiff(repoPath, file);
  }

  async log(repoPath: string, limit?: number): Promise<GitCommit[]> {
    return this.gateway.gitLog(repoPath, limit);
  }

  async branches(repoPath: string): Promise<GitBranch[]> {
    return this.gateway.gitBranches(repoPath);
  }

  /** Get changed files grouped by staged/unstaged. */
  async getChangedFiles(repoPath: string): Promise<{
    staged: GitChangedFile[];
    unstaged: GitChangedFile[];
    untracked: GitChangedFile[];
  }> {
    const status = await this.status(repoPath);
    const staged: GitChangedFile[] = [];
    const unstaged: GitChangedFile[] = [];
    const untracked: GitChangedFile[] = [];

    for (const file of status.changedFiles) {
      if (file.status === 'untracked') {
        untracked.push(file);
      } else if (file.staged) {
        staged.push(file);
      } else {
        unstaged.push(file);
      }
    }

    return { staged, unstaged, untracked };
  }
}
