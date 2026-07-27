import { describe, expect, it } from 'vitest';
import { buildDefaultSystemPrompt } from './default-system-prompt';

describe('buildDefaultSystemPrompt', () => {
  it('does not deny MCP access when the gateway is connected', () => {
    const prompt = buildDefaultSystemPrompt({ gatewayAvailable: true });

    expect(prompt).toContain('The MCP Gateway is connected');
    expect(prompt).not.toContain('No external MCP servers are currently connected');
  });

  it('reports unavailable MCP access only when neither direct servers nor the gateway exists', () => {
    const prompt = buildDefaultSystemPrompt();

    expect(prompt).toContain('No external MCP servers are currently connected');
  });
});

