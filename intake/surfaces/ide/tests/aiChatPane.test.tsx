import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIChatPane, buildSystemPrompt, selectConversationHistory } from '@/opencode';
import { HostProvider } from '@/platform/HostProvider';
import { MockHostGateway } from '@/platform/host';
import { useUIStore } from '@/store/uiStore';

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
    useUIStore.setState({ aiProviderId: null, aiModel: null });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exposes only configured Vault routes and no direct credential controls', async () => {
    const gateway = new MockHostGateway();
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);
    await waitFor(() => expect(screen.getByLabelText('Provider')).toBeEnabled());
    const provider = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.text)).toEqual(['Anthropic', 'Z.ai']);
    expect(provider).toHaveValue('zai');
    expect(screen.queryByLabelText('Provider API key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('API base URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dialect')).not.toBeInTheDocument();
    expect(Array.from((screen.getByLabelText('Mode') as HTMLSelectElement).options).map((option) => option.text)).toEqual(['Ask', 'Edit active file', 'Agent']);
    expect(screen.getByLabelText('Model')).toHaveValue('glm-4.7');
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
        providerId: 'zai',
        baseUrl: 'http://127.0.0.1:13031/p/zai/api/coding/paas/v4',
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

  it('offers the live Vault model list for the selected provider and persists the choice', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/vault/catalog') return catalogResponse();
      if (url === '/api/models?provider=zai') {
        return new Response(JSON.stringify({
          provider: 'zai', source: 'live', fetchedAt: '2026-07-31T12:00:00-04:00',
          models: [
            { id: 'glm-4.8', name: 'GLM 4.8' },
            { id: 'glm-4.7', name: 'GLM 4.7' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/models?provider=anthropic') {
        return new Response(JSON.stringify({
          provider: 'anthropic', source: 'live', fetchedAt: '2026-07-31T12:00:00-04:00',
          models: [
            { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    const gateway = new MockHostGateway();
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);

    await waitFor(() => expect(Array.from((screen.getByLabelText('Model') as HTMLSelectElement).options).map((option) => option.text)).toEqual(['GLM 4.8', 'GLM 4.7']));
    expect(screen.getByLabelText('Provider')).toHaveValue('zai');
    expect(screen.getByLabelText('Model')).toHaveValue('glm-4.8');
    await waitFor(() => expect(useUIStore.getState().aiModel).toBe('glm-4.8'));

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } });
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('claude-sonnet-4-6'));
    expect(Array.from((screen.getByLabelText('Model') as HTMLSelectElement).options).map((option) => option.text)).toEqual(['Claude Opus 4.7', 'Claude Sonnet 4.6']);
    await waitFor(() => expect(useUIStore.getState().aiProviderId).toBe('anthropic'));
    expect(useUIStore.getState().aiModel).toBe('claude-sonnet-4-6');
  });

  it('re-seeds to GLM when the persisted provider is no longer Vault-configured', async () => {
    useUIStore.setState({ aiProviderId: 'openai', aiModel: 'gpt-5.2-codex' });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/vault/catalog') return catalogResponse();
      if (url === '/api/models?provider=zai') {
        return new Response(JSON.stringify({
          provider: 'zai', source: 'live', fetchedAt: '2026-07-31T12:00:00-04:00',
          models: [{ id: 'glm-4.8', name: 'GLM 4.8' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    const gateway = new MockHostGateway();
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);

    await waitFor(() => expect(screen.getByLabelText('Provider')).toHaveValue('zai'));
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('glm-4.8'));
    await waitFor(() => expect(useUIStore.getState().aiProviderId).toBe('zai'));
    expect(useUIStore.getState().aiModel).toBe('glm-4.8');
  });

  it('shows when the Vault answered through the GLM fallback', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/vault/catalog') return catalogResponse();
      if (url === '/api/models?provider=zai') {
        return new Response(JSON.stringify({ provider: 'zai', source: 'live', models: [{ id: 'glm-4.8', name: 'GLM 4.8' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/models?provider=anthropic') {
        return new Response(JSON.stringify({ provider: 'anthropic', source: 'live', models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: fallback\ndata: {"type":"fallback","requestedProvider":"anthropic","model":"glm-4.8"}\n\n'));
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

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } });
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('claude-sonnet-4-6'));
    fireEvent.change(screen.getByLabelText('Message CURSEM'), { target: { value: 'Say hello' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));

    await waitFor(() => expect(screen.getByText('assistant works')).toBeInTheDocument());
    expect(screen.getByText('Anthropic failed — answered by GLM (glm-4.8)')).toBeInTheDocument();
    expect(appendEvent).toHaveBeenCalledWith(expect.any(String), 'model.fallback', { requestedProviderId: 'anthropic', servedModel: 'glm-4.8' });
  });

  it('restores the Floyd Core route and draft, and publishes the local selection', async () => {
    const published: Array<{ modelRoute?: { provider?: string; model?: string }; composerDraft?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/vault/catalog') return catalogResponse();
      if (url === '/api/core/experience') {
        return new Response(JSON.stringify({
          available: true, revision: 3,
          modelRoute: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          composerDraft: 'continue from the TUI',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/core/experience/publish') {
        published.push(JSON.parse(String(init?.body || '{}')));
        return new Response(JSON.stringify({ available: true, revision: 4 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/models?provider=zai') {
        return new Response(JSON.stringify({ provider: 'zai', source: 'live', models: [{ id: 'glm-4.8', name: 'GLM 4.8' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/models?provider=anthropic') {
        return new Response(JSON.stringify({ provider: 'anthropic', source: 'live', models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    const gateway = new MockHostGateway();
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);

    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('claude-sonnet-4-6'));
    expect(screen.getByLabelText('Provider')).toHaveValue('anthropic');
    expect(screen.getByLabelText('Message CURSEM')).toHaveValue('continue from the TUI');
    await waitFor(() => expect(useUIStore.getState().aiProviderId).toBe('anthropic'));
    await waitFor(() => expect(published.some((entry) => entry.modelRoute?.provider === 'anthropic' && entry.modelRoute?.model === 'claude-sonnet-4-6')).toBe(true));
    await waitFor(() => expect(published.some((entry) => entry.composerDraft === 'continue from the TUI')).toBe(true), { timeout: 3_000 });
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
