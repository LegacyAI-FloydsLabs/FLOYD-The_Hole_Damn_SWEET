#!/usr/bin/env node

/**
 * Interactive Harness Test Suite (DEBUG VERSION)
 * Tests that harnesses launch successfully and accept input
 */

const WebSocket = require('ws');

function testHarness(harness, port = 11000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const startTime = Date.now();
    let launched = false;
    let receivedOutput = false;
    let outputBytes = 0;
    let testFailed = false;

    const timeout = setTimeout(() => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      const status = (launched && receivedOutput && !testFailed) ? 'PASS' : 'FAIL';
      console.log(`    ${status === 'PASS' ? '✓' : '✗'} ${status} (${duration}ms, ${outputBytes}B, launched=${launched}, output=${receivedOutput})`);

      resolve({
        harness,
        status,
        duration,
        launched,
        receivedOutput,
        outputBytes
      });

      ws.close();
    }, 2500);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'launch', harness }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.type === 'launched') {
          launched = true;
        } else if (msg.type === 'output') {
          receivedOutput = true;
          outputBytes += msg.data.length;
        } else if (msg.type === 'error') {
          console.log(`    ✗ Error: ${msg.message}`);
          testFailed = true;
          clearTimeout(timeout);
          ws.close();
        }
      } catch (e) {
        console.error(`    Parse error:`, e.message);
      }
    });

    ws.on('error', (error) => {
      console.log(`    ✗ WebSocket error: ${error.message}`);
      testFailed = true;
      clearTimeout(timeout);
      ws.close();
    });
  });
}

async function runTests() {
  const harnesses = [
    'pi', 'omp', 'omf', 'ff', 'floyd_56', 'floyd_good', 'floyd2',
    'openclaw', 'pebkac', 'gsd', 'sf', 'droid', 'crush', 'floyd-wrapper'
  ];

  const port = process.env.PORT || 11000;
  console.log(`🧪 Interactive Harness Test Suite (Port ${port})\n`);

  const results = [];
  let completed = 0;

  for (const harness of harnesses) {
    process.stdout.write(`[${++completed}/${harnesses.length}] Testing ${harness.padEnd(20)}: `);
    const result = await testHarness(harness, port);
    results.push(result);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n📊 Test Results\n');
  console.log('='.repeat(80));

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status !== 'PASS').length;

  results.forEach(r => {
    const statusIcon = r.status === 'PASS' ? '✓' : '✗';
    console.log(`${statusIcon} ${r.harness.padEnd(20)} | ${r.status.padEnd(10)} | ${r.duration}ms | ${r.outputBytes}B`);
  });

  console.log('='.repeat(80));
  console.log(`\nSummary: ${passed} PASSED, ${failed} FAILED out of ${harnesses.length}\n`);

  process.exit(passed === harnesses.length ? 0 : 1);
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
