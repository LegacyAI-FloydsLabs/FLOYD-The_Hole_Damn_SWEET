#!/usr/bin/env node
/**
 * Production Load Test (CORRECTED)
 * Tests concurrent WebSocket connections with proper protocol
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = 11000;
const BASE_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;
const HARNESSES = ['pi', 'omp', 'omf', 'ff', 'floyd_56'];
const CONCURRENT_SESSIONS = 30;
const SESSION_TIMEOUT_MS = 5000;

let sessionCount = 0;
let successCount = 0;
let errorCount = 0;
const startTime = Date.now();

async function testConcurrentSessions() {
  const connections = [];
  const results = [];
  
  return new Promise((resolve) => {
    for (let i = 0; i < CONCURRENT_SESSIONS; i++) {
      const harness = HARNESSES[i % HARNESSES.length];
      sessionCount++;
      
      const ws = new WebSocket(WS_URL);
      const result = { 
        harness, 
        id: i, 
        connected: false, 
        launched: false,
        received: false, 
        errors: [] 
      };
      
      ws.on('open', () => {
        result.connected = true;
        // SEND LAUNCH MESSAGE (this was the missing piece)
        ws.send(JSON.stringify({ type: 'launch', harness }));
      });
      
      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg);
          if (data.type === 'launched') {
            result.launched = true;
          } else if (data.type === 'output') {
            result.received = true;
          }
        } catch (e) {
          result.errors.push('parse_error');
        }
      });
      
      ws.on('error', (err) => {
        result.errors.push(err.message);
        errorCount++;
      });
      
      connections.push(ws);
      results.push(result);
    }
    
    // Wait for all sessions to complete
    setTimeout(() => {
      connections.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      });
      
      // Count results
      const connected = results.filter(r => r.connected).length;
      const launched = results.filter(r => r.launched).length;
      const received = results.filter(r => r.received).length;
      successCount = received;
      
      resolve({ connected, launched, received, results });
    }, SESSION_TIMEOUT_MS);
  });
}

async function runTests() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('PRODUCTION LOAD TEST (CORRECTED) - harness-launcher');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const result = await testConcurrentSessions();
  
  console.log('TEST: Concurrent Sessions with Proper Protocol (30 simultaneous)');
  console.log(`  Connected: ${result.connected}/${CONCURRENT_SESSIONS}`);
  console.log(`  Launched: ${result.launched}/${CONCURRENT_SESSIONS}`);
  console.log(`  Received Data: ${result.received}/${CONCURRENT_SESSIONS}`);
  
  const passRate = (result.received / CONCURRENT_SESSIONS * 100).toFixed(1);
  console.log(`  Pass Rate: ${passRate}%`);
  console.log(`  Result: ${result.received >= CONCURRENT_SESSIONS * 0.95 ? '✅ PASS' : '⚠️  DEGRADED'}`);
  
  const totalTime = Date.now() - startTime;
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log(`  Total Time: ${totalTime}ms`);
  console.log(`  Sessions Completed Successfully: ${result.received}/${sessionCount}`);
  console.log(`  Errors: ${errorCount}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  process.exit(result.received >= CONCURRENT_SESSIONS * 0.9 ? 0 : 1);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
