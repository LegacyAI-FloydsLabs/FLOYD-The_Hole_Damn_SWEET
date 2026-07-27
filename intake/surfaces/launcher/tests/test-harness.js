#!/usr/bin/env node
/**
 * Single Harness Test
 * Tests one harness at a time with timeout
 */

const WebSocket = require('ws');

function testHarness(harness) {
  return new Promise((resolve) => {
      const ws = new WebSocket('ws://localhost:11000');
      let output = '';
      let sessionId = '';
      const timeout = 2500;
      const startTime = Date.now();

      ws.on('open', () => {
          ws.send(JSON.stringify({ action: 'launch', harness }));
      });

      ws.on('message', (data) => {
          try {
              const msg = JSON.parse(data);
              if (msg.sessionId) sessionId = msg.sessionId;
              if (msg.output) output = msg.output;
          } catch (e) {}
      });

      ws.on('error', (err) => {
          console.log(`✗ FAIL`);
          resolve();
      });

      setTimeout(() => {
          ws.close();
          const elapsed = Date.now() - startTime;
          const status = output.length > 0 ? '✓ PASS' : '✗ FAIL';
          console.log(`${status.padEnd(8)} | ${elapsed}ms | ${output.length}B`);
          resolve();
      }, timeout);
  });}

async function runTests() {
  const harnesses = process.argv.slice(2) || ['omp'];
  
  console.log(`\n🧪 Testing ${harnesses.length} harness(es)\n`);

  for (const harness of harnesses) {
    process.stdout.write(`  Testing ${harness.padEnd(20)}: `);
    await testHarness(harness);
    await new Promise(r => setTimeout(r, 1000));  // Stagger requests
  }
  
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
