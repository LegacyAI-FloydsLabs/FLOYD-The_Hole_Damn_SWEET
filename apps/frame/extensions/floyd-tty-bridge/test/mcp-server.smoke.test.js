import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  TOOL_DEFINITIONS,
  createMcpServer,
  handleJsonRpcMessage
} from '../mcp-server.js';

function parseSingleLine(jsonl) {
  const trimmed = jsonl.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed);
}

describe('mcp-server smoke', () => {
  it('returns expected initialize payload', () => {
    const response = handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    });

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        capabilities: { tools: {} },
        serverInfo: { name: 'floyd-bridge', version: '5.0.0' },
        protocolVersion: '2024-11-05'
      }
    });
  });

  it('lists all bridge tools with JSON schemas', () => {
    const response = handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });

    expect(response.result.tools.length).toBeGreaterThanOrEqual(30);
    expect(response.result.tools.length).toBe(TOOL_DEFINITIONS.length);

    const names = new Set(response.result.tools.map((tool) => tool.name));
    expect(names.has('navigate_to')).toBe(true);
    expect(names.has('set_of_marks')).toBe(true);
    expect(names.has('gif_stop')).toBe(true);
    expect(names.has('checkpoint_restore')).toBe(true);

    for (const tool of response.result.tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeTypeOf('object');
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('routes tools/call for known tools', () => {
    const response = handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'click_element',
        arguments: { selector: '#submit' }
      }
    });

    expect(response.result.isError).toBe(false);
    expect(response.result.structuredContent.tool).toBe('click_element');
    expect(response.result.structuredContent.arguments).toEqual({ selector: '#submit' });
    expect(response.result.structuredContent.routed).toBe(true);
  });

  it('acknowledges initialized notification with no response', () => {
    const response = handleJsonRpcMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    });

    expect(response).toBeNull();
  });

  it('handles stdio JSON-RPC line input and emits JSON line output', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const server = createMcpServer(input, output, errorOutput);

    const outputPromise = new Promise((resolve) => {
      output.once('data', (chunk) => {
        resolve(parseSingleLine(chunk.toString('utf8')));
      });
    });

    input.write('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}\n');
    const message = await outputPromise;

    expect(message.id).toBe(9);
    expect(message.result.structuredContent.tool).toBe('list_tabs');

    server.close();
  });

  it('returns parse error for malformed JSON input line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const server = createMcpServer(input, output, errorOutput);

    const outputPromise = new Promise((resolve) => {
      output.once('data', (chunk) => {
        resolve(parseSingleLine(chunk.toString('utf8')));
      });
    });

    input.write('{"jsonrpc":"2.0","id":4,"method":"initialize"\n');
    const message = await outputPromise;

    expect(message.error.code).toBe(-32700);

    server.close();
  });
});
