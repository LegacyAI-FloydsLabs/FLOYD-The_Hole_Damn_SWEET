#!/usr/bin/env node
/**
 * Reliability Test — Respawn Race (CR-006)
 * Verifies that a client-initiated close during the respawn window (50ms after
 * shell self-exit) does NOT cause an unwanted respawn.
 *
 * Sequence:
 *   1. Launch bare shell
 *   2. Send 'exit\r' to trigger shell self-exit (server schedules respawn in 50ms)
 *   3. Receive 'shell-reset' (expected — shell self-exited)
 *   4. Immediately send {type:'close'}
 *   5. Wait 500ms (well beyond the 50ms respawn window)
 *   6. Assert: no new 'launched' message received (no respawn occurred)
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 11000;
const RESPAWN_WINDOW_MS = 50;
const SETTLE_MS = 500;
const TIMEOUT_MS = 10000;

function testRespawnRace() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    let launchedCount = 0;
    let shellResetReceived = false;
    let closeSent = false;
    let resolved = false;
    let outputAfterClose = false;
    let launchedAfterClose = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      finish('TIMEOUT', 'Test timed out');
    }, TIMEOUT_MS);

    function finish(status, reason) {
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN) ws.close();

      const passed = status === 'PASS';
      resolve({
        status: passed ? 'PASS' : 'FAIL',
        reason: passed ? 'No respawn after client close during respawn window' : reason,
        launchedCount,
        shellResetReceived,
        launchedAfterClose,
        outputAfterClose,
      });
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'shell', cols: 80, rows: 24 }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'launched') {
          launchedCount++;

          if (closeSent) {
            launchedAfterClose = true;
            if (resolved) return;
            resolved = true;
            finish('FAIL', `Respawn occurred after close: received 'launched' (count=${launchedCount})`);
          } else if (launchedCount === 1) {
            // Shell is live — give it a moment to initialize, then send 'exit' to trigger
            // shell self-exit (which schedules the 50ms respawn window we want to race).
            setTimeout(() => {
              if (!closeSent && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }));
              }
            }, 500);
          }
        } else if (msg.type === 'output') {
          if (closeSent) {
            outputAfterClose = true;
            if (resolved) return;
            resolved = true;
            finish('FAIL', 'Output received after close — respawn likely occurred');
          }
        } else if (msg.type === 'shell-reset') {
          shellResetReceived = true;

          // Shell self-exited — server scheduled respawn in 50ms.
          // Send close immediately to race the respawn window.
          if (!closeSent) {
            closeSent = true;
            ws.send(JSON.stringify({ type: 'close' }));

            // Wait well beyond the 50ms respawn window
            setTimeout(() => {
              if (resolved) return;
              resolved = true;
              if (launchedAfterClose || outputAfterClose) {
                finish('FAIL', `Respawn detected after close (launched=${launchedAfterClose}, output=${outputAfterClose})`);
              } else {
                finish('PASS', 'No respawn after close');
              }
            }, SETTLE_MS);
          }
        } else if (msg.type === 'exit') {
          // Clean exit from client-close path — expected
          if (!resolved) {
            // Wait a bit more to see if respawn fires
            setTimeout(() => {
              if (resolved) return;
              resolved = true;
              if (launchedAfterClose || outputAfterClose) {
                finish('FAIL', `Respawn after exit (launched=${launchedAfterClose}, output=${outputAfterClose})`);
              } else {
                finish('PASS', 'Clean exit, no respawn');
              }
            }, SETTLE_MS);
          }
        } else if (msg.type === 'error') {
          if (resolved) return;
          resolved = true;
          finish('FAIL', `Server error: ${msg.message || msg.code}`);
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    ws.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      finish('FAIL', `WebSocket error: ${err.message}`);
    });
  });
}

(async () => {
  console.log('Reliability Test — Respawn Race (CR-006)\n');
  const result = await testRespawnRace();
  console.log(`  Status:            ${result.status}`);
  console.log(`  Reason:            ${result.reason}`);
  console.log(`  Launched count:    ${result.launchedCount}`);
  console.log(`  Shell-reset:       ${result.shellResetReceived}`);
  console.log(`  Launched after close: ${result.launchedAfterClose}`);
  console.log(`  Output after close:   ${result.outputAfterClose}`);
  console.log('');
  const pass = result.status === 'PASS';
  console.log(pass ? '✅ PASS — no respawn race' : '❌ FAIL — respawn race detected');
  process.exit(pass ? 0 : 1);
})();
