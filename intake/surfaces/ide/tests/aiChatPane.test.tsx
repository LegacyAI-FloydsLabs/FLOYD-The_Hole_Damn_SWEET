import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIChatPane, buildSystemPrompt, selectConversationHistory } from '@/opencode';
import { HostProvider } from '@/platform/HostProvider';
import { MockHostGateway } from '@/platform/host';

const VAULT_CATALOG = {
  proxyUrl: 'http://127.0.0.1:13031',
  providers: [
    { id: 'anthropic', configured: true, protocol: 'anthropic', proxyPath: '/p/anthropic/v1', models: ['claude-sonnet-4-6'] },
    { id: 'zai', configured: true, protocol: 'openai', proxyPath: '/p/zai/api/coding/paas/v4', models: ['glm-4.7'] },
  ],
};

function catalogResponse(): Response {
  return new Response(JSON.stringify(VAULT_CATALOG), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CURSEM coding partner pane', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/vault/catalog') return catalogResponse();
      throw new Error(`unexpected request: ${String(input)}`);
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exposes only configured Vault routes and no direct credential controls', async () => {
    const gateway = new MockHostGateway();
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);
    await waitFor(() => expect(screen.getByLabelText('Provider')).toBeEnabled());
    const provider = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.text)).toEqual(['Anthropic', 'Z.ai']);
    expect(screen.queryByLabelText('Provider API key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('API base URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dialect')).not.toBeInTheDocument();
    expect(Array.from((screen.getByLabelText('Mode') as HTMLSelectElement).options).map((option) => option.text)).toEqual(['Ask', 'Edit active file', 'Agent']);
    expect(screen.getByLabelText('Model')).toHaveValue('claude-sonnet-4-6');
    expect(screen.getByText(/credentials, addresses, and protocol are supplied by the local Vault/)).toBeInTheDocument();
    expect(screen.getByLabelText('include context')).toBeEnabled();
  });

  it('fails closed when the Vault catalog is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    const gateway = new MockHostGateway();
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);
    fireEvent.change(screen.getByLabelText('Message CURSEM'), { target: { value: 'Review this code' } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Vault catalog HTTP 503'));
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled();
    expect(screen.getByLabelText('Provider')).toBeDisabled();
  });

  it('streams through the same-origin gateway without a browser credential', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/api/vault/catalog') return catalogResponse();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: delta\ndata: {"type":"delta","text":"assistant works"}\n\n'));
          controller.enqueue(encoder.encode('event: done\ndata: {"type":"done","finishReason":"stop"}\n\n'));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new MockHostGateway();
    const appendEvent = vi.spyOn(gateway, 'agentAppendEvent');
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);
    await waitFor(() => expect(screen.getByText('Vault ready')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Message CURSEM'), { target: { value: 'Say hello' } });
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValue(1_025);
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));

    await waitFor(() => expect(screen.getByText('assistant works')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/gateway', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }));
    const gatewayCall = fetchMock.mock.calls.find(([input]) => String(input) === '/gateway');
    expect(gatewayCall).toBeDefined();
    expect(String(gatewayCall?.[1]?.body)).not.toMatch(/apiKey|api_key|credentialMode|authorization/i);
    expect(JSON.parse(String(gatewayCall?.[1]?.body))).toMatchObject({
      provider: {
        providerId: 'anthropic',
        baseUrl: 'http://127.0.0.1:13031/p/anthropic/v1',
      },
    });
    expect(appendEvent).toHaveBeenCalledWith(expect.any(String), 'model.first_token', { elapsedMs: 25 });
  });

  it('rejects an empty completion while transmitting no browser credential', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/api/vault/catalog') return catalogResponse();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: done\ndata: {"type":"done","finishReason":"stop"}\n\n'));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new MockHostGateway();
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);
    await waitFor(() => expect(screen.getByText('Vault ready')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Message CURSEM'), { target: { value: 'Use the saved key' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/gateway', expect.any(Object)));
    const gatewayCall = fetchMock.mock.calls.find(([input]) => String(input) === '/gateway');
    const init = gatewayCall?.[1] as RequestInit;
    expect(init.headers).not.toHaveProperty('authorization');
    expect(String(init.body)).not.toMatch(/apiKey|api_key|credentialMode|authorization/i);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('without returning visible text'));
    expect(screen.queryByText('The provider completed without returning text.')).not.toBeInTheDocument();
  });

  it('tells the selected model its IDE role and current workspace context', () => {
    expect(buildSystemPrompt({
      mode: 'ask',
      workspaceRoot: '/workspace/project',
      activeTabPath: '/workspace/project/src/app.ts',
      providerLabel: 'OpenCode Go',
      model: 'deepseek-v4-flash',
    })).toContain('You are the selected model running as CURSEM');
    expect(buildSystemPrompt({
      mode: 'ask',
      workspaceRoot: '/workspace/project',
      activeTabPath: '/workspace/project/src/app.ts',
      providerLabel: 'OpenCode Go',
      model: 'deepseek-v4-flash',
    })).toContain('Workspace root: /workspace/project');
    expect(buildSystemPrompt({
      mode: 'ask',
      workspaceRoot: '/workspace/project',
      activeTabPath: '/workspace/project/src/app.ts',
      providerLabel: 'OpenCode Go',
      model: 'deepseek-v4-flash',
    })).toContain('Selected provider/model: OpenCode Go / deepseek-v4-flash');
    expect(buildSystemPrompt({
      mode: 'edit',
      workspaceRoot: '/workspace/project',
      activeTabPath: '/workspace/project/src/app.ts',
      providerLabel: 'OpenCode Go',
      model: 'deepseek-v4-flash',
    })).toContain('<cursem-tool>');
  });

  it('starts with a clean conversation instead of automatically replaying durable history', async () => {
    const gateway = new MockHostGateway();
    const listThreads = vi.fn(async () => [{ id: 'old-thread', title: 'Old verification', createdAt: 1, updatedAt: 2 }]);
    const getThread = vi.fn(async () => ({
      id: 'old-thread', title: 'Old verification', createdAt: 1, updatedAt: 2,
      messages: [{ id: 'old-message', threadId: 'old-thread', role: 'assistant' as const, content: 'stale mock transcript', metadata: {}, createdAt: 1 }],
      runs: [],
    }));
    Object.defineProperty(gateway, 'agentListThreads', { value: listThreads });
    Object.defineProperty(gateway, 'agentGetThread', { value: getThread });

    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);
    await waitFor(() => expect(screen.getByLabelText('Conversation history')).toHaveTextContent('Old verification'));

    expect(getThread).not.toHaveBeenCalled();
    expect(screen.queryByText('stale mock transcript')).not.toBeInTheDocument();
    expect(screen.getByText('Build with CURSEM')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Conversation history'), { target: { value: 'old-thread' } });
    await waitFor(() => expect(screen.getByText('stale mock transcript')).toBeInTheDocument());
    expect(getThread).toHaveBeenCalledWith('old-thread');
    expect(screen.getByText('Vault ready')).toBeInTheDocument();
    expect(screen.queryByText(/preparing ·/)).not.toBeInTheDocument();
  });

  it('bounds prior conversation text before sending it back to a provider', () => {
    const history = selectConversationHistory([
      { id: '1', role: 'user', content: 'old '.repeat(10_000) },
      { id: '2', role: 'assistant', content: 'recent answer' },
      { id: '3', role: 'user', content: 'recent question' },
    ], 128);

    expect(history).toEqual([
      { role: 'assistant', content: 'recent answer' },
      { role: 'user', content: 'recent question' },
    ]);
    expect(JSON.stringify(history)).not.toContain('old old old');
  });
});
