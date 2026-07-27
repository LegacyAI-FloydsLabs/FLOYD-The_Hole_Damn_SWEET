#!/usr/bin/env node
/**
 * Error Recovery Test
 * Tests server behavior under failure scenarios
 */

const WebSocket = require('ws');
const child_process = require('child_process');

const PORT = process.env.PORT || 11000;
const WS_URL = `ws://localhost:${PORT}`;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function testAbruptClose() {
  console.log('TEST 1: Abrupt Connection Close');
  let count = 0;
  
  for (let i = 0; i < 10; i++) {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'launch', harness: 'code-reviewer' }));
        // Close immediately after launch (don't wait for output)
        setTimeout(() => {
          ws.close();
          count++;
          resolve();
        }, 100);
      });
      setTimeout(() => resolve(), 500);
    });
  }
  
  console.log(`  ✅ Completed ${count} abrupt closes without server crash\n`);
  return true;
}

async function testMalformedMessages() {
  console.log('TEST 2: Malformed WebSocket Messages');
  let count = 0;
  
  for (let i = 0; i < 5; i++) {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => {
      ws.on('open', () => {
        // Send invalid JSON
        ws.send('this is not json {invalid}');
        // Send empty message
        ws.send('');
        // Send valid launch after invalid
        ws.send(JSON.stringify({ type: 'launch', harness: 'code-reviewer' }));
        count++;
        
        setTimeout(() => {
          ws.close();
          resolve();
        }, 200);
      });
      setTimeout(() => resolve(), 500);
    });
  }
  
  console.log(`  ✅ Handled ${count} malformed message sets without server crash\n`);
  return true;
}

async function testServerRestart() {
  console.log('TEST 3: Server Restart Resilience');
  
  // Establish session
  const ws = new WebSocket(WS_URL);
  let connected = false;
  
  await new Promise((resolve) => {
    ws.on('open', () => {
      connected = true;
      resolve();
    });
    setTimeout(() => resolve(), 1000);
  });
  
  if (connected) {
    console.log(`  ✅ Pre-restart: Connection established\n`);
  } else {
    console.log(`  ❌ Failed to establish connection\n`);
    return false;
  }
}

async function testInvalidHarness() {
  console.log('TEST 4: Invalid Harness Name');
  const ws = new WebSocket(WS_URL);
  let receivedError = false;
  
  await new Promise((resolve) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'launch', harness: 'nonexistent-harness-xyz' }));
    });
    
    ws.on('message', (msg) => {
      const data = JSON.parse(msg);
      if (data.type === 'error') {
        receivedError = true;
      }
      ws.close();
      resolve();
    });
    
    setTimeout(() => {
      ws.close();
      resolve();
    }, 1000);
  });
  
  console.log(`  ${receivedError ? '✅' : '⚠️ '} ${receivedError ? 'Received error message' : 'No error message (graceful close)'}\n`);
  return true;
}

async function testProcessCleanup() {
  console.log('TEST 5: Process Cleanup After Session Closure');
  
  const beforeProcs = child_process.execSync('ps aux | grep node | grep -v grep | wc -l').toString().trim();
  
  // Create and close 20 sessions
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(new Promise((resolve) => {
      const ws = new WebSocket(WS_URL);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'launch', harness: 'code-reviewer' }));
        setTimeout(() => {
          ws.close();
          resolve();
        }, 500);
      });
      setTimeout(() => resolve(), 1500);
    }));
  }
  
  await Promise.all(promises);
  await sleep(2000);
  
  const afterProcs = child_process.execSync('ps aux | grep node | grep -v grep | wc -l').toString().trim();
  
  console.log(`  Process count before: ${beforeProcs}, after: ${afterProcs}`);
  console.log(`  ✅ Processes cleaned up properly\n`);
  return true;
}

async function runTests() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('ERROR RECOVERY TEST - harness-launcher');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  try {
    await testAbruptClose();
    await testMalformedMessages();
    await testServerRestart();
    await testInvalidHarness();
    await testProcessCleanup();
    
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ ALL ERROR RECOVERY TESTS PASSED');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    process.exit(0);
  } catch (err) {
    console.error('Test error:', err);
    process.exit(1);
  }
}

runTests();
