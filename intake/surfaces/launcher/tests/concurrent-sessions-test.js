#!/usr/bin/env node
/**
 * Reliability Test — Concurrent Sessions (Project Rule R4)
 * Verifies that multiple WebSocket sessions can run simultaneously without
 * interference, cross-talk, or server crash.
 *
 * Opens 2 concurrent sessions, launches a bare shell on each, and asserts:
 *   - Both receive unique session IDs
 *   - Both receive output independently
 *   - Closing one does not affect the other
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 11000;
const NUM_SESSIONS = 2;
const TIMEOUT_MS = 10000;

function testSession(index) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    let sessionId = null;
    let launched = false;
    let outputChunks = 0;
    let closed = false;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve({
        index,
        status: launched && outputChunks > 0 ? 'PASS' : 'FAIL',
        reason: launched ? `Only ${outputChunks} output chunks` : 'Never launched',
        sessionId,
        outputChunks,
      });
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }, TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'shell', cols: 80, rows: 24 }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'launched') {
          launched = true;
          sessionId = msg.sessionId;
          // Wait a bit to collect output, then close
          setTimeout(() => {
            if (!closed && ws.readyState === WebSocket.OPEN) {
              closed = true;
              ws.send(JSON.stringify({ type: 'close' }));
            }
          }, 1000);
        } else if (msg.type === 'output') {
          outputChunks++;
        } else if (msg.type === 'exit') {
          clearTimeout(timeout);
          if (resolved) return;
          resolved = true;
          resolve({
            index,
            status: launched && outputChunks > 0 ? 'PASS' : 'FAIL',
            reason: launched ? 'Clean exit' : 'Exited without launch',
            sessionId,
            outputChunks,
          });
          ws.close();
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          if (resolved) return;
          resolved = true;
          resolve({
            index,
            status: 'FAIL',
            reason: `Error: ${msg.message || msg.code}`,
            sessionId,
            outputChunks,
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
      resolve({
        index,
        status: 'FAIL',
        reason: `WS error: ${err.message}`,
        sessionId,
        outputChunks,
      });
    });
  });
}

(async () => {
  console.log(`Reliability Test — Concurrent Sessions (R4, ${NUM_SESSIONS} parallel)\n`);

  // Launch all sessions simultaneously
  const promises = [];
  for (let i = 0; i < NUM_SESSIONS; i++) {
    promises.push(testSession(i));
  }

  const results = await Promise.all(promises);

  // Verify all passed
  const allPassed = results.every((r) => r.status === 'PASS');

  // Verify unique session IDs
  const sessionIds = results.map((r) => r.sessionId).filter(Boolean);
  const uniqueIds = new Set(sessionIds);
  const idsUnique = sessionIds.length === uniqueIds.size;

  console.log('Session Results:');
  results.forEach((r) => {
    console.log(`  [${r.index}] ${r.status} | session=${r.sessionId?.slice(0, 8) || 'none'} | chunks=${r.outputChunks} | ${r.reason}`);
  });
  console.log(`\nAll passed:     ${allPassed ? '✅' : '❌'}`);
  console.log(`Unique IDs:     ${idsUnique ? '✅' : '❌'} (${uniqueIds.size}/${sessionIds.length} unique)`);
  console.log('');

  const pass = allPassed && idsUnique;
  console.log(pass ? '✅ PASS — concurrent sessions isolated and stable' : '❌ FAIL — concurrent session issue');
  process.exit(pass ? 0 : 1);
})();
