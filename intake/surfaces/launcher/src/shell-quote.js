'use strict';

/**
 * shell-quote — command-line construction for the PTY launch wrapper.
 *
 * The launcher drives the PTY by writing a command line into a login shell,
 * so every interpolated token must be shell-safe. Extracted from server.js
 * so the construction is unit-testable without spawning a PTY.
 */

const path = require('path');

/**
 * CR-004: single-quote a token for safe shell interpolation.
 * Embedded single quotes use the classic '"'"' idiom.
 * @param {*} s
 * @returns {string}
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

/**
 * Build the command line written to the PTY for a harness launch.
 *
 * CR-004: client-supplied args are single-quoted (injection guard).
 * CR-013: the resolved harness binary is quoted as well. Every roster entry
 * resolves to a single absolute path (harnesses.js `stub()`), and the
 * installed app lives under "/Applications/FLOYD Desktop Suite.app/..." —
 * spliced raw, the space word-splits and zsh tries to execute the first
 * word ("no such file or directory: /Applications/FLOYD"). Quoting applies
 * whenever the resolution is a single executable reference — an absolute
 * path (spaces included) or a whitespace-free bare command name. A compound
 * command string (e.g. "npx -y @scope/pkg") is relative AND contains
 * whitespace; it passes through with its own spacing intact.
 *
 * @param {string} resolved - Resolved harness binary path or command
 * @param {string[]} [args] - Client-supplied launch args
 * @returns {string}
 */
function buildLaunchCommand(resolved, args = []) {
  const singleExecutable = path.isAbsolute(resolved) || !/\s/.test(resolved);
  const resolvedShell = singleExecutable ? shellQuote(resolved) : resolved;
  const escapedArgs = args.map(shellQuote);
  return resolvedShell + (escapedArgs.length ? ' ' + escapedArgs.join(' ') : '');
}

module.exports = { shellQuote, buildLaunchCommand };
