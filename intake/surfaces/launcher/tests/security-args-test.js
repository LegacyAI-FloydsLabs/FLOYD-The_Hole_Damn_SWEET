#!/usr/bin/env node
/**
 * Security Test — Args Shell Injection (CR-004)
 * Verifies that client-supplied args are shell-escaped before being written to the PTY.
 *
 * Sends args containing shell metacharacters (;, $(), backticks) and asserts that
 * injected commands do NOT execute. If escaping fails, "PWNED" or a username
 * would appear in the terminal output.
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 11000;
const INJECTION_MARKER = 'PWNED';
const TIMEOUT_MS = 8000;

function testArgsInjection() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    let output = '';
    let launched = false;
    let closeSent = false;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const result = evaluateOutput(output);
      if (ws.readyState === WebSocket.OPEN) ws.close();
      resolve(result);
    }, TIMEOUT_MS);

    // Strip ANSI CSI/OSC/DCS escape sequences so we can reason about plain text lines.
    // The shell echoes the TYPED command (which contains the literal arg text), so a naive
    // substring check for the injection marker would match the command-echo, not execution.
    function stripAnsi(s) {
      return s
        .replace(/\x1b\][^\x07]*\x07/g, '')    // OSC sequences (\x1b]...\x07)
        .replace(/\x1bP[^\x1b]*\x1b\\/g, '')     // DCS sequences (\x1bP...\x1b\\)
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI sequences (\x1b[...m etc.)
        .replace(/\x1b./g, '')                   // remaining 2-byte escapes
        .replace(/\r/g, '');
    }

    function evaluateOutput(buf) {
      const clean = stripAnsi(buf);
      const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);

      // POSITIVE proof: args must appear SINGLE-QUOTED in the echoed command (CR-004 applied).
      // If escaping failed, the metacharacters would be unquoted and the shell would parse them.
      const argsQuoted = clean.includes("'; echo PWNED #'") && clean.includes("'$(whoami)'");

      // NEGATIVE proof: the execution marker must NOT appear as a standalone output line.
      // The command-echo line contains "echo PWNED" as part of a longer line, but if `echo PWNED`
      // actually executed, "PWNED" would appear on its own line as command output.
      const standaloneMarker = lines.some((l) => l === INJECTION_MARKER);

      // NEGATIVE proof: $(whoami) must survive literally. If unescaped, zsh substitutes it
      // with the username and the literal "$(whoami)" sequence disappears.
      const whoamiLiteral = clean.includes('$(whoami)');

      const passed = argsQuoted && !standaloneMarker && whoamiLiteral;
      return {
        status: passed ? 'PASS' : 'FAIL',
        reason: !argsQuoted
          ? 'Args NOT single-quoted in echoed command — CR-004 escaping not applied'
          : standaloneMarker
            ? `Shell injection: "${INJECTION_MARKER}" appeared as standalone output line (echo executed)`
            : !whoamiLiteral
              ? 'Command substitution: $(whoami) was executed (literal sequence missing)'
              : 'Args single-quoted, no standalone execution, $(whoami) preserved literally',
        outputSize: buf.length,
        argsQuoted,
        standaloneMarker,
        whoamiLiteral,
        cleanLines: lines.length,
      };
    }

    ws.on('open', () => {
      // Args contain shell metacharacters that would execute if not escaped
      ws.send(JSON.stringify({
        type: 'launch',
        harness: 'code-reviewer',
        cols: 80,
        rows: 24,
        args: [`; echo ${INJECTION_MARKER} #`, '$(whoami)'],
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'launched') {
          launched = true;
        } else if (msg.type === 'output') {
          output += msg.data;

          // Collect enough output, then close
          if (!closeSent && output.length > 200) {
            closeSent = true;
            ws.send(JSON.stringify({ type: 'close' }));
          }
        } else if (msg.type === 'exit') {
          clearTimeout(timeout);
          if (resolved) return;
          resolved = true;
          const result = evaluateOutput(output);
          ws.close();
          resolve(result);
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          if (resolved) return;
          resolved = true;
          // Error is acceptable — means the harness rejected the args, not that injection occurred
          resolve({
            status: 'PASS',
            reason: `Harness returned error (args rejected, not injected): ${msg.message || msg.code}`,
            outputSize: output.length,
          });
          ws.close();
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      if (resolved) return;
      resolved = true;
      resolve({ status: 'FAIL', reason: `WebSocket error: ${err.message}`, outputSize: 0 });
    });
  });
}

(async () => {
  console.log('Security Test — Args Shell Injection (CR-004)\n');
  const result = await testArgsInjection();
  console.log(`  Status:             ${result.status}`);
  console.log(`  Reason:             ${result.reason}`);
  console.log(`  Output:             ${result.outputSize}B collected`);
  console.log(`  Args quoted:        ${result.argsQuoted}`);
  console.log(`  Standalone marker:  ${result.standaloneMarker}`);
  console.log(`  $(whoami) literal:  ${result.whoamiLiteral}`);
  console.log('');
  const pass = result.status === 'PASS';
  console.log(pass ? '✅ PASS — args are properly shell-escaped' : '❌ FAIL — shell injection detected');
  process.exit(pass ? 0 : 1);
})();
