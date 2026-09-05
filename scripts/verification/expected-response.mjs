// CURSEM reports Git's normal "not a repository" result as HTTP 400 when its
// initial workspace is the packaged, non-Git application directory.
export function isExpectedNonGitFolder(url, status, body) {
  const parsed = new URL(url);
  return parsed.origin === 'http://127.0.0.1:13012'
    && parsed.pathname === '/api/git/status'
    && status === 400
    && /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/i.test(body?.error?.message || '');
}
