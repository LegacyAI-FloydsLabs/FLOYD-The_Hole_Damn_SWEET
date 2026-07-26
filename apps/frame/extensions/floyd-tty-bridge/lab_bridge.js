const { spawn } = require('child_process');
const path = require('path');

const serverPath = '/Volumes/Storage/MCP/hivemind-v2/dist/index.js';
const toolName = process.argv[2];
const toolArgs = JSON.parse(process.argv[3] || '{}');

const server = spawn('node', [serverPath], {
  env: { ...process.env, DEBUG: 'mcp:*' }
});

let output = '';
server.stdout.on('data', (data) => {
  output += data.toString();
  try {
    const response = JSON.parse(output);
    if (response.id === 1) {
      console.log(JSON.stringify(response.result || response.error, null, 2));
      server.kill();
      process.exit(0);
    }
  } catch (e) {
    // Wait for complete JSON
  }
});

server.stderr.on('data', (data) => {
  // Silent log
});

const request = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: toolName,
    arguments: toolArgs
  }
};

server.stdin.write(JSON.stringify(request) + '\n');
