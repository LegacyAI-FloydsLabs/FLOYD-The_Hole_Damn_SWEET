#!/usr/bin/env node
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER_INFO = {
  name: 'floyd-bridge',
  version: '5.0.0'
};

const PROTOCOL_VERSION = '2024-11-05';

function objectSchema(properties, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: true
  };
}

const TOOL_DEFINITIONS = [
  { category: 'navigation', name: 'navigate_to', description: 'Navigate the current tab to a URL.', inputSchema: objectSchema({ url: { type: 'string', description: 'Target URL.' } }, ['url']) },
  { category: 'navigation', name: 'open_tab', description: 'Open a new browser tab.', inputSchema: objectSchema({ url: { type: 'string', description: 'Target URL.' } }, ['url']) },
  { category: 'navigation', name: 'close_tab', description: 'Close a tab by tab ID.', inputSchema: objectSchema({ tab_id: { type: 'number', description: 'Tab ID to close.' } }, ['tab_id']) },
  { category: 'navigation', name: 'switch_tab', description: 'Switch focus to a tab by tab ID.', inputSchema: objectSchema({ tab_id: { type: 'number', description: 'Tab ID to activate.' } }, ['tab_id']) },
  { category: 'navigation', name: 'list_tabs', description: 'List currently open tabs.', inputSchema: objectSchema({}) },
  { category: 'navigation', name: 'get_tab_state', description: 'Get metadata for a tab.', inputSchema: objectSchema({ tab_id: { type: 'number', description: 'Optional tab ID. Defaults to active tab when available.' } }) },
  { category: 'navigation', name: 'get_page_state', description: 'Get page URL, title, viewport, and scroll state.', inputSchema: objectSchema({}) },

  { category: 'interaction', name: 'click_element', description: 'Click a DOM element by CSS selector.', inputSchema: objectSchema({ selector: { type: 'string', description: 'CSS selector.' } }, ['selector']) },
  { category: 'interaction', name: 'type_text', description: 'Type text into an input-like element.', inputSchema: objectSchema({ selector: { type: 'string', description: 'CSS selector for input.' }, text: { type: 'string', description: 'Text to type.' }, clear_first: { type: 'boolean', description: 'Clear existing text first.' } }, ['selector', 'text']) },
  { category: 'interaction', name: 'fill_form', description: 'Fill multiple fields in one call.', inputSchema: objectSchema({ fields: { type: 'array', description: 'Array of selector/value pairs.', items: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'], additionalProperties: false } } }, ['fields']) },
  { category: 'interaction', name: 'select_option', description: 'Select an option in a <select> element.', inputSchema: objectSchema({ selector: { type: 'string' }, value: { type: 'string' } }, ['selector', 'value']) },
  { category: 'interaction', name: 'scroll_to', description: 'Scroll to top/bottom/direction or a selector.', inputSchema: objectSchema({ target: { type: 'string', description: 'top, bottom, up, down, or a CSS selector.' } }, ['target']) },
  { category: 'interaction', name: 'wait_for_element', description: 'Wait for selector to appear.', inputSchema: objectSchema({ selector: { type: 'string' }, timeout: { type: 'number', description: 'Timeout in milliseconds.' } }, ['selector']) },
  { category: 'interaction', name: 'click_ref', description: 'Click an element by ref ID.', inputSchema: objectSchema({ ref: { type: 'string', description: 'Reference ID from distill/read output.' } }, ['ref']) },
  { category: 'interaction', name: 'type_ref', description: 'Type text into an element by ref ID.', inputSchema: objectSchema({ ref: { type: 'string' }, text: { type: 'string' } }, ['ref', 'text']) },
  { category: 'interaction', name: 'scroll_to_ref', description: 'Scroll element with ref ID into view.', inputSchema: objectSchema({ ref: { type: 'string' } }, ['ref']) },
  { category: 'interaction', name: 'click_mark', description: 'Click a numbered Set-of-Marks marker.', inputSchema: objectSchema({ mark: { type: 'integer', description: 'Mark number.' } }, ['mark']) },

  { category: 'analysis', name: 'analyze_page', description: 'Comprehensive page analysis including structure and quality signals.', inputSchema: objectSchema({ include_css: { type: 'boolean' }, include_accessibility: { type: 'boolean' }, viewport_scroll: { type: 'boolean' } }) },
  { category: 'analysis', name: 'analyze_element', description: 'Deep analysis of one element.', inputSchema: objectSchema({ selector: { type: 'string' } }, ['selector']) },
  { category: 'analysis', name: 'find_elements', description: 'Search visible elements by text/aria/placeholder/alt/role.', inputSchema: objectSchema({ query: { type: 'string' }, search_by: { type: 'string', enum: ['any', 'text', 'aria', 'placeholder', 'alt', 'role'] }, limit: { type: 'number' } }, ['query']) },
  { category: 'analysis', name: 'extract_text', description: 'Extract text from matched elements.', inputSchema: objectSchema({ selector: { type: 'string' }, limit: { type: 'number' } }, ['selector']) },
  { category: 'analysis', name: 'extract_css', description: 'Extract computed styles for an element.', inputSchema: objectSchema({ selector: { type: 'string' }, properties: { type: 'array', items: { type: 'string' } } }, ['selector']) },
  { category: 'analysis', name: 'check_accessibility', description: 'Run accessibility checks and report violations.', inputSchema: objectSchema({ scope: { type: 'string' }, level: { type: 'string', enum: ['A', 'AA', 'AAA'] } }) },
  { category: 'analysis', name: 'check_contrast', description: 'Compute text contrast issues for selector or whole page.', inputSchema: objectSchema({ selector: { type: 'string' } }) },

  { category: 'capture', name: 'take_screenshot', description: 'Capture current tab screenshot.', inputSchema: objectSchema({ full_page: { type: 'boolean' } }) },
  { category: 'capture', name: 'read_page', description: 'Read page via accessibility-tree generator.', inputSchema: objectSchema({ filter: { type: 'string' }, depth: { type: 'number' }, max_chars: { type: 'number' }, ref_id: { type: 'string' } }) },
  { category: 'capture', name: 'read_console', description: 'Read captured page console logs.', inputSchema: objectSchema({ onlyErrors: { type: 'boolean' }, limit: { type: 'number' }, clear: { type: 'boolean' }, pattern: { type: 'string' } }) },
  { category: 'capture', name: 'distill_dom', description: 'Return distilled DOM content in selected mode.', inputSchema: objectSchema({ mode: { type: 'string', enum: ['text_only', 'input_fields', 'all_content'] }, filter: { type: 'string' }, depth: { type: 'number' }, max_chars: { type: 'number' }, ref_id: { type: 'string' } }) },
  { category: 'capture', name: 'get_dom_changes', description: 'Read and clear buffered DOM mutations.', inputSchema: objectSchema({}) },
  { category: 'capture', name: 'read_network', description: 'Read captured network events.', inputSchema: objectSchema({ urlPattern: { type: 'string' }, limit: { type: 'number' }, clear: { type: 'boolean' } }) },

  { category: 'agent', name: 'set_of_marks', description: 'Render numbered marks on interactive elements.', inputSchema: objectSchema({ show: { type: 'boolean' }, filter: { type: 'string', enum: ['interactive', 'forms', 'all'] } }) },
  { category: 'agent', name: 'quick', description: 'Execute Quick Mode command script.', inputSchema: objectSchema({ commands: { type: 'string', description: 'Newline-separated quick mode commands.' } }, ['commands']) },
  { category: 'agent', name: 'write_observation', description: 'Write page observation to local scratchpad.', inputSchema: objectSchema({ summary: { type: 'string' }, include_css: { type: 'boolean' }, include_accessibility: { type: 'boolean' } }) },
  { category: 'agent', name: 'read_commands', description: 'Read pending markdown command queue.', inputSchema: objectSchema({}) },
  { category: 'agent', name: 'query_knowledge', description: 'Query bridge knowledge base endpoint.', inputSchema: objectSchema({ query: { type: 'string' }, limit: { type: 'number' }, domain: { type: 'string' }, category: { type: 'string' } }, ['query']) },

  { category: 'platform', name: 'download', description: 'Start browser download.', inputSchema: objectSchema({ url: { type: 'string' }, filename: { type: 'string' }, saveAs: { type: 'boolean' } }, ['url']) },
  { category: 'platform', name: 'download_status', description: 'Get status for a download ID.', inputSchema: objectSchema({ downloadId: { type: 'number' } }, ['downloadId']) },
  { category: 'platform', name: 'add_net_rule', description: 'Add a declarative network rule.', inputSchema: objectSchema({ id: { type: 'integer' }, action: { type: 'string', enum: ['block', 'redirect', 'modifyHeaders'] }, condition: { type: 'object', properties: { urlFilter: { type: 'string' }, resourceTypes: { type: 'array', items: { type: 'string' } } }, required: ['urlFilter'], additionalProperties: true }, redirect: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false }, headers: { type: 'array', items: { type: 'object', properties: { header: { type: 'string' }, operation: { type: 'string' }, value: { type: 'string' } }, required: ['header', 'operation'], additionalProperties: true } }, priority: { type: 'integer' } }, ['id', 'action', 'condition']) },
  { category: 'platform', name: 'remove_net_rule', description: 'Remove declarative network rule by ID.', inputSchema: objectSchema({ id: { type: 'integer' } }, ['id']) },
  { category: 'platform', name: 'checkpoint_save', description: 'Save current automation checkpoint state.', inputSchema: objectSchema({ name: { type: 'string' }, note: { type: 'string' } }) },
  { category: 'platform', name: 'checkpoint_restore', description: 'Restore a saved automation checkpoint.', inputSchema: objectSchema({ checkpoint_id: { type: 'string' }, name: { type: 'string' } }) },

  { category: 'gif', name: 'gif_start', description: 'Start a GIF recording session.', inputSchema: objectSchema({}) },
  { category: 'gif', name: 'gif_add_frame', description: 'Add a frame to active GIF session.', inputSchema: objectSchema({ imageData: { type: 'string' }, action: { type: 'object' }, viewportWidth: { type: 'number' }, viewportHeight: { type: 'number' } }, ['imageData']) },
  { category: 'gif', name: 'gif_stop', description: 'Stop GIF recording and return frame summary.', inputSchema: objectSchema({ filename: { type: 'string' } }) }
];

const TOOL_MAP = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function validateJsonRpcRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return 'Request must be a JSON object.';
  }
  if (message.jsonrpc !== '2.0') {
    return 'jsonrpc must be "2.0".';
  }
  if (typeof message.method !== 'string' || message.method.length === 0) {
    return 'method must be a non-empty string.';
  }
  return null;
}

function isNotification(message) {
  return typeof message.id === 'undefined';
}

function createJsonRpcResult(id, result) {
  return { jsonrpc: '2.0', result, id };
}

function createJsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (typeof data !== 'undefined') {
    error.data = data;
  }
  return { jsonrpc: '2.0', error, id: typeof id === 'undefined' ? null : id };
}

function callTool(name, args = {}) {
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      structuredContent: { success: false, error: `Unknown tool: ${name}` }
    };
  }

  const result = {
    success: true,
    routed: true,
    tool: name,
    category: tool.category,
    transport: 'native_messaging_placeholder',
    arguments: args || {}
  };

  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result
  };
}

export function handleJsonRpcMessage(message) {
  const validationError = validateJsonRpcRequest(message);
  if (validationError) {
    return createJsonRpcError(message && message.id, -32600, 'Invalid Request', { reason: validationError });
  }

  const { method, params, id } = message;

  if (method === 'notifications/initialized') {
    return null;
  }

  if (method === 'initialize') {
    return createJsonRpcResult(id, {
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      protocolVersion: PROTOCOL_VERSION
    });
  }

  if (method === 'tools/list') {
    return createJsonRpcResult(id, {
      tools: TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    });
  }

  if (method === 'tools/call') {
    const toolName = params && params.name;
    const toolArgs = params && typeof params.arguments === 'object' && params.arguments !== null
      ? params.arguments
      : {};

    if (typeof toolName !== 'string' || toolName.length === 0) {
      return createJsonRpcError(id, -32602, 'Invalid params', { reason: 'tools/call requires params.name' });
    }

    return createJsonRpcResult(id, callTool(toolName, toolArgs));
  }

  if (method.startsWith('notifications/')) {
    return null;
  }

  if (isNotification(message)) {
    return null;
  }

  return createJsonRpcError(id, -32601, 'Method not found', { method });
}

export function createMcpServer(input = process.stdin, output = process.stdout, errorOutput = process.stderr) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  function writeMessage(message) {
    output.write(`${JSON.stringify(message)}\n`);
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (_error) {
      writeMessage(createJsonRpcError(null, -32700, 'Parse error'));
      return;
    }

    const response = handleJsonRpcMessage(parsed);
    if (response !== null) {
      writeMessage(response);
    }
  });

  rl.on('close', () => {
    try {
      errorOutput.write('[floyd-mcp] stdin closed\n');
    } catch (_error) {
    }
  });

  return {
    close() {
      rl.close();
    }
  };
}

export { TOOL_DEFINITIONS, PROTOCOL_VERSION, SERVER_INFO };

const isMainModule = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch (_error) {
    return false;
  }
})();

if (isMainModule) {
  createMcpServer();
}
