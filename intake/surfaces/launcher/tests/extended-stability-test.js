#!/usr/bin/env node
/**
 * Extended Stability Test
 * Tests server behavior over extended time, error scenarios, memory usage
 */

const WebSocket = require('ws');
const http = require('http');
const child_process = require('child_process');

const PORT = 11000;
const WS_URL = `ws://localhost:${PORT}`;
const TEST_DURATION_MS = 60000; // 60 seconds
const CONCURRENT_PER_BATCH = 10;

let totalSessions = 0;
let totalSuccess = 0;
let totalErrors = 0;
let peakMemoryMB = 0;

async function batchTest(batchNum, durationMs) {
  return new Promise((resolve) => {
    const startBatchTime = Date.now();
    const batchResults = [];
    let completedInBatch = 0;
    
    const interval = setInterval(() => {
      if (Date.now() - startBatchTime > durationMs) {
        clearInterval(interval);
        
        // Close remaining connections
        batchResults.forEach(r => {
          if (r.ws && r.ws.readyState === WebSocket.OPEN) {
            r.ws.close();
          }
        });
        
        const successful = batchResults.filter(r => r.received).length;
        resolve({ batchNum, created: batchResults.length, successful });
        return;
      }
      
      // Launch new session
      const ws = new WebSocket(WS_URL);
      const sessionResult = { ws, received: false, errors: [] };
      batchResults.push(sessionResult);
      totalSessions++;
      
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'launch', harness: 'pi' }));
      });
      
      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg);
          if (data.type === 'output') {
            sessionResult.received = true;
          }
        } catch (e) {}
      });
      
      ws.on('error', (err) => {
        totalErrors++;
        sessionResult.errors.push(err.message);
      });
      
      // Auto-close after 3 seconds
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }, 3000);
      
    }, 100); // Create new session every 100ms
  });
}

function getProcessStats() {
  const usage = process.memoryUsage();
  const heapUsed = Math.round(usage.heapUsed / 1024 / 1024);
  if (heapUsed > peakMemoryMB) {
    peakMemoryMB = heapUsed;
  }
  return {
    heapUsed,
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
    rss: Math.round(usage.rss / 1024 / 1024),
    external: Math.round(usage.external / 1024 / 1024)
  };
}

async function runTest() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('EXTENDED STABILITY TEST - harness-launcher');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log(`Testing over ${TEST_DURATION_MS}ms with continuous session creation...\n`);
  
  const testStart = Date.now();
  let batchNum = 0;
  
  while (Date.now() - testStart < TEST_DURATION_MS) {
    batchNum++;
    const batchDuration = Math.min(10000, TEST_DURATION_MS - (Date.now() - testStart));
    process.stdout.write(`[Batch ${batchNum}] Running...`);
    
    const result = await batchTest(batchNum, batchDuration);
    const stats = getProcessStats();
    
    totalSuccess += result.successful;
    console.log(`\r[Batch ${batchNum}] Created: ${result.created}, Success: ${result.successful}/${result.created}, Memory: ${stats.heapUsed}MB / ${stats.heapTotal}MB        `);
  }
  
  const totalTime = Date.now() - testStart;
  const successRate = totalSuccess / totalSessions * 100;
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('STABILITY TEST RESULTS');
  console.log(`  Duration: ${totalTime}ms`);
  console.log(`  Total Sessions Created: ${totalSessions}`);
  console.log(`  Successful: ${totalSuccess}`);
  console.log(`  Failed: ${totalErrors}`);
  console.log(`  Success Rate: ${successRate.toFixed(1)}%`);
  console.log(`  Peak Memory: ${peakMemoryMB}MB`);
  console.log(`  Result: ${successRate >= 95 ? '✅ PASS' : '⚠️  DEGRADED'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  process.exit(successRate >= 95 ? 0 : 1);
}

runTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
