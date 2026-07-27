#!/usr/bin/env node
/**
 * Stress Test
 * Tests server behavior at resource limits
 */

const WebSocket = require('ws');
const os = require('os');

const PORT = 11000;
const WS_URL = `ws://localhost:${PORT}`;

async function stressTest() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('STRESS TEST - Resource Limits');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const results = {
    simultaneous: 0,
    successful: 0,
    failed: 0,
    timeouts: 0
  };
  
  // Test 1: Rapid fire 100 simultaneous connections
  console.log('TEST 1: 100 Simultaneous Connections (Fire & Forget)');
  
  const connections = [];
  const timeout = setTimeout(() => {
    results.timeouts++;
  }, 15000);
  
  for (let i = 0; i < 100; i++) {
    const ws = new WebSocket(WS_URL);
    results.simultaneous++;
    
    ws.on('open', () => {
      results.successful++;
      ws.send(JSON.stringify({ type: 'launch', harness: 'pi' }));
      setTimeout(() => ws.close(), Math.random() * 2000 + 1000);
    });
    
    ws.on('error', () => {
      results.failed++;
    });
    
    connections.push(ws);
  }
  
  // Wait for all to complete or timeout
  await new Promise(resolve => setTimeout(resolve, 15000));
  clearTimeout(timeout);
  
  connections.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.close();
    }
  });
  
  console.log(`  Simultaneous: ${results.simultaneous}`);
  console.log(`  Connected: ${results.successful}`);
  console.log(`  Failed: ${results.failed}`);
  console.log(`  Result: ${results.successful >= 95 ? '✅ PASS' : '⚠️  DEGRADED'}\n`);
  
  // Test 2: Sustained high load
  console.log('TEST 2: Sustained High Load (200 connections over 30s)');
  
  let sustained = { created: 0, success: 0, failed: 0 };
  const startTime = Date.now();
  
  const interval = setInterval(() => {
    if (Date.now() - startTime > 30000) {
      clearInterval(interval);
      return;
    }
    
    for (let i = 0; i < 7; i++) {
      const ws = new WebSocket(WS_URL);
      sustained.created++;
      
      ws.on('open', () => {
        sustained.success++;
        ws.send(JSON.stringify({ type: 'launch', harness: ['pi', 'omp', 'omf', 'ff'][Math.floor(Math.random() * 4)] }));
      });
      
      ws.on('error', () => {
        sustained.failed++;
      });
      
      ws.on('close', () => {});
      
      setTimeout(() => ws.close(), 1000 + Math.random() * 2000);
    }
  }, 1000);
  
  await new Promise(resolve => setTimeout(resolve, 35000));
  
  console.log(`  Created: ${sustained.created}`);
  console.log(`  Connected: ${sustained.success}`);
  console.log(`  Failed: ${sustained.failed}`);
  const sustainedRate = (sustained.success / sustained.created * 100).toFixed(1);
  console.log(`  Success Rate: ${sustainedRate}%`);
  console.log(`  Result: ${sustained.success / sustained.created > 0.9 ? '✅ PASS' : '⚠️  DEGRADED'}\n`);
  
  // Test 3: Check system stats
  console.log('TEST 3: System Resource Usage');
  
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
  const rssMB = Math.round(usage.rss / 1024 / 1024);
  const cpuUsage = process.cpuUsage();
  
  console.log(`  Heap Used: ${heapUsedMB}MB / ${heapTotalMB}MB`);
  console.log(`  RSS: ${rssMB}MB`);
  console.log(`  User CPU: ${(cpuUsage.user / 1000).toFixed(0)}ms`);
  console.log(`  System CPU: ${(cpuUsage.system / 1000).toFixed(0)}ms`);
  console.log(`  Result: ${heapUsedMB < 100 ? '✅ PASS' : '⚠️  HIGH'}\n`);
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('✅ STRESS TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

stressTest().catch(err => {
  console.error('Stress test failed:', err);
  process.exit(1);
});
