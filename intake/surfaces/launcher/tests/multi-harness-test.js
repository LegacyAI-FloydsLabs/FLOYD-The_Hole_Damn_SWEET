#!/usr/bin/env node
/**
 * Multi-Harness Test Suite
 * Tests all registered harnesses via WebSocket with proper terminal emulation protocol.
 * Harness list is derived from src/harnesses.js (single source of truth, per project rule R5).
 */

const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// CR-007: derive test list from the registry to prevent drift
const { HARNESSES } = require('../src/harnesses');
const harnesses = HARNESSES.map((h) => ({ name: h.name, type: h.type }));

const PORT = process.env.PORT || 11000;
const results = [];

function testHarness(harness) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const startTime = Date.now();
    let launched = false;
    let outputChunks = 0;
    let outputBytes = 0;
    let testFailed = false;
    let closeSent = false;

    const OUTPUT_THRESHOLD = 3;

    const timeout = setTimeout(() => {
      testFailed = true;
      if (ws.readyState === WebSocket.OPEN) ws.close();
      results.push({
        harness: harness.name,
        status: 'TIMEOUT',
        duration: Date.now() - startTime,
        launched,
        outputChunks,
        outputBytes,
        error: 'Test timed out after 10s'
      });
      resolve();
    }, 10000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'launch', harness: harness.name, cols: 80, rows: 24 }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'launched') {
          launched = true;
        } else if (msg.type === 'output') {
          outputChunks++;
          outputBytes += msg.data.length;

          if (outputChunks >= OUTPUT_THRESHOLD && !closeSent) {
            closeSent = true;
            ws.send(JSON.stringify({ type: 'close' }));
          }
        } else if (msg.type === 'exit') {
          clearTimeout(timeout);
          if (!testFailed) {
            results.push({
              harness: harness.name,
              status: launched && outputChunks > 0 ? 'PASS' : 'FAIL',
              duration: Date.now() - startTime,
              launched,
              outputChunks,
              outputBytes,
              exitCode: msg.code,
              error: !launched ? 'Never received launched message' : (outputChunks === 0 ? 'No output received' : null)
            });
          }
          ws.close();
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          testFailed = true;
          results.push({
            harness: harness.name,
            status: 'ERROR',
            duration: Date.now() - startTime,
            launched,
            outputChunks,
            outputBytes,
            error: msg.message
          });
          ws.close();
          resolve();
        }
      } catch (e) {
        console.error(`Parse error for ${harness.name}:`, e.message);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      if (!testFailed) {
        testFailed = true;
        results.push({
          harness: harness.name,
          status: 'WS_ERROR',
          duration: Date.now() - startTime,
          launched,
          outputChunks,
          outputBytes,
          error: err.message
        });
        resolve();
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (!testFailed && !results.find(r => r.harness === harness.name)) {
        results.push({
          harness: harness.name,
          status: 'WS_ERROR',
          duration: Date.now() - startTime,
          launched,
          outputChunks,
          outputBytes,
          error: 'WebSocket closed unexpectedly'
        });
        resolve();
      }
    });
  });
}

async function runTests() {
  console.log('Multi-Harness Test Suite Starting\n');
  console.log(`Testing ${harnesses.length} harnesses on port ${PORT}...\n`);

  let completed = 0;
  for (const harness of harnesses) {
    process.stdout.write(`[${++completed}/${harnesses.length}] Testing ${harness.name}... `);
    await testHarness(harness);
    const result = results[results.length - 1];
    const icon = result.status === 'PASS' ? 'PASS' : result.status === 'TIMEOUT' ? 'TIMEOUT' : 'FAIL';
    console.log(`${icon} (${result.duration}ms, ${result.outputChunks} chunks, ${result.outputBytes}B)`);

    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\nTest Results\n');
  console.log('='.repeat(80));

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status !== 'PASS').length;

  results.forEach(r => {
    const icon = r.status === 'PASS' ? 'PASS' : 'FAIL';
    console.log(`${icon} ${r.harness.padEnd(20)} | ${r.status.padEnd(10)} | ${r.duration}ms | ${r.outputChunks} chunks | ${r.outputBytes}B`);
    if (r.error) {
      console.log(`  Error: ${r.error}`);
    }
  });

  console.log('='.repeat(80));
  console.log(`\nSummary: ${passed} PASSED, ${failed} FAILED out of ${harnesses.length}\n`);

  fs.writeFileSync(
    path.join(__dirname, 'MULTIHARNESS-TEST-RESULTS.json'),
    JSON.stringify(results, null, 2)
  );
  console.log('Results saved to MULTIHARNESS-TEST-RESULTS.json');

  process.exit(passed === harnesses.length ? 0 : 1);
}

runTests().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
