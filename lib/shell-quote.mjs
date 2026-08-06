/**
 * shell-quote (ESM) — single-quote a token for safe shell interpolation.
 *
 * Any path that can contain spaces (the installed app lives under
 * "/Applications/FLOYD Desktop Suite.app/...") MUST go through shellQuote
 * before being spliced into a shell command line; unquoted, the path
 * word-splits and the shell tries to execute the first word
 * ("no such file or directory: /Applications/FLOYD", exit 127).
 *
 * Twin of the launcher surface's CJS src/shell-quote.js (kept separate
 * because that server is CommonJS); tests live in tests/shell-quote.test.mjs.
 * Embedded single quotes use the classic '"'"' idiom.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
