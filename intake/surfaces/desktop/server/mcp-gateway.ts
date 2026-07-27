/**
 * MCP Gateway integration — one thin front door to the entire MCP fleet.
 *
 * The gateway (/Volumes/applebottom/MCP_SERVER_ROOM/mcp-gateway) exposes 6
 * meta-tools and lazily brokers ~30 backend servers / 200+ tools. Wiring it
 * here costs the agent only these meta-tool definitions instead of the whole
 * fleet's schemas.
 *
 * Lifecycle: spawned lazily on first gateway tool call, kept alive for the
 * process lifetime, reconnected automatically if the child dies.
 */

import { MCPClient } from './mcp-client.js';
import { existsSync } from 'fs';

const GATEWAY_ROOT = process.env.MCP_GATEWAY_DIR || '/Volumes/applebottom/MCP_SERVER_ROOM/mcp-gateway';
const GATEWAY_ENTRY = `${GATEWAY_ROOT}/dist/index.js`;

let client: MCPClient | null = null;
let connecting: Promise<MCPClient> | null = null;

export function gatewayAvailable(): boolean {
  return existsSync(GATEWAY_ENTRY);
}

async function getClient(): Promise<MCPClient> {
  if (client?.connected) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    const c = new MCPClient({
      name: 'mcp-gateway',
      command: process.execPath,
      args: [GATEWAY_ENTRY],
    });
    await c.connect();
    client = c;
    return c;
  })();

  try {
    return await connecting;
  } catch (err) {
    client = null;
    throw err;
  } finally {
    connecting = null;
  }
}

/** Call one of the gateway's meta-tools. Reconnects once on a dead child. */
export async function callGateway(tool: string, args: Record<string, unknown>): Promise<any> {
  let c = await getClient();
  try {
    return await c.callTool(tool, args);
  } catch (err) {
    // Child may have died — one clean reconnect, then surface the error.
    client = null;
    c = await getClient();
    return c.callTool(tool, args);
  }
}

/** Tool definitions offered to the chat agent (generic MCP inputSchema shape). */
export const GATEWAY_TOOLS = [
  {
    name: 'mcp_search_tools',
    description: 'Search the entire MCP fleet (~30 servers, 200+ tools) by intent. Returns ranked {server, tool, description} refs. This is the primary way to discover a capability you do not have built in — ALWAYS try this before telling the user a capability is unavailable. Example queries: "apply a git diff", "store a memory", "generate an image", "run a sandboxed command".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, in plain words' },
        limit: { type: 'number', description: 'Max results (default 15)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mcp_describe_tool',
    description: 'Get the full description and exact input schema for one tool on one MCP server. Call this after mcp_search_tools and before mcp_call_tool so you pass correct arguments — search results alone do not show the schema.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server id, e.g. floyd-git-mcp' },
        tool: { type: 'string', description: 'Tool name on that server' },
      },
      required: ['server', 'tool'],
    },
  },
  {
    name: 'mcp_call_tool',
    description: 'Invoke a tool on a backend MCP server through the gateway. The gateway lazily connects to the backend and proxies the call. Use mcp_describe_tool first to learn the exact argument schema.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server id from mcp_search_tools/mcp_list_servers' },
        tool: { type: 'string', description: 'Tool name on that server' },
        arguments: { type: 'object', description: 'Arguments object for the backend tool' },
        timeout_ms: { type: 'number', description: 'Per-call timeout, capped at 300000' },
      },
      required: ['server', 'tool'],
    },
  },
  {
    name: 'mcp_list_servers',
    description: 'List every MCP server the gateway can reach, with category, tool count, transport, and reachability. Use to browse the fleet; use mcp_search_tools when you know what capability you need.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category (development, memory, terminal, ai, ...)' },
        kind: { type: 'string', description: 'Filter by kind (shared-utility, product-control, remote-service)' },
      },
    },
  },
  {
    name: 'mcp_health_check',
    description: 'Check reachability of one MCP server (live connect) or the whole fleet (from index). Use to diagnose a failing mcp_call_tool before retrying.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server id to live-check; omit for fleet summary' },
      },
    },
  },
];

/** Map an agent-facing gateway tool name to the gateway's own tool name. */
const NAME_MAP: Record<string, string> = {
  mcp_search_tools: 'search_tools',
  mcp_describe_tool: 'describe_tool',
  mcp_call_tool: 'call_tool',
  mcp_list_servers: 'list_servers',
  mcp_health_check: 'health_check',
};

export function isGatewayTool(name: string): boolean {
  return name in NAME_MAP;
}

export async function executeGatewayTool(name: string, args: Record<string, unknown>): Promise<{ success: boolean; result?: any; error?: string }> {
  if (!gatewayAvailable()) {
    return { success: false, error: `MCP gateway not installed at ${GATEWAY_ENTRY}` };
  }
  try {
    const raw = await callGateway(NAME_MAP[name], args);
    // Gateway results carry content blocks; prefer structuredContent, fall back to text.
    if (raw?.structuredContent) return { success: true, result: raw.structuredContent };
    const text = Array.isArray(raw?.content)
      ? raw.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
      : undefined;
    if (text) {
      try { return { success: true, result: JSON.parse(text) }; } catch { return { success: true, result: text }; }
    }
    return { success: true, result: raw };
  } catch (err: any) {
    return { success: false, error: `Gateway error: ${err.message}` };
  }
}
