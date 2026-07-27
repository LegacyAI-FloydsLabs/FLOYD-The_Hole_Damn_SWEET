import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIChatPane, buildSystemPrompt, selectConversationHistory } from '@/opencode';
import { HostProvider } from '@/platform/HostProvider';
import { MockHostGateway } from '@/platform/host';

describe('CURSEM coding partner pane', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exposes all four providers, memory-only key input, dialect override, and context control', async () => {
    const gateway = new MockHostGateway();
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);
    await act(async () => undefined);
    const provider = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.text)).toEqual(['OpenCode Go', 'OpenCode Zen', 'OpenAI', 'Anthropic']);
    expect(screen.getByLabelText('Provider API key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Use credential proxy')).toBeChecked();
    expect(screen.getByLabelText('Provider API key')).toBeDisabled();
    expect(screen.getByLabelText('Dialect')).toBeInTheDocument();
    expect(Array.from((screen.getByLabelText('Mode') as HTMLSelectElement).options).map((option) => option.text)).toEqual(['Ask', 'Edit active file', 'Agent']);
    expect(screen.getByLabelText('Model')).toHaveValue('claude-sonnet-4-6');
    expect(screen.getByText(/Provider credentials remain in the credential proxy/)).toBeInTheDocument();
    expect(screen.getByLabelText('include context')).toBeEnabled();
  });

  it('switches provider invariants and refuses to send without a key', async () => {
    const gateway = new MockHostGateway();
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);
    await act(async () => undefined);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } });
    expect(screen.getByLabelText('API base URL')).toHaveValue('https://api.anthropic.com/v1');
    expect(screen.getByLabelText('Model')).toHaveValue('claude-sonnet-4-6');
    fireEvent.click(screen.getByLabelText('Use credential proxy'));
    fireEvent.change(screen.getByLabelText('Message CURSEM'), { target: { value: 'Review this code' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the provider API key');
  });

  it('streams a response through the gateway when a user API key is supplied', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: delta\ndata: {"type":"delta","text":"assistant works"}\n\n'));
        controller.enqueue(encoder.encode('event: done\ndata: {"type":"done","finishReason":"stop"}\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new MockHostGateway();
    const appendEvent = vi.spyOn(gateway, 'agentAppendEvent');
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);
    await act(async () => undefined);

    fireEvent.click(screen.getByLabelText('Use credential proxy'));
    fireEvent.change(screen.getByLabelText('Provider API key'), { target: { value: 'fake-key' } });
    fireEvent.change(screen.getByLabelText('Message CURSEM'), { target: { value: 'Say hello' } });
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValue(1_025);
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));

    await waitFor(() => expect(screen.getByText('assistant works')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/gateway', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-api-key': 'fake-key', 'anthropic-version': '2023-06-01' }),
    }));
    expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain('fake-key');
    expect(appendEvent).toHaveBeenCalledWith(expect.any(String), 'model.first_token', { elapsedMs: 25 });
  });

  it('uses the credential proxy by default, transmits no browser key, and rejects an empty provider completion', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: done\ndata: {"type":"done","finishReason":"stop"}\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new MockHostGateway();
    render(<HostProvider config={gateway.config} gateway={gateway}><AIChatPane /></HostProvider>);
    await act(async () => undefined);

    fireEvent.change(screen.getByLabelText('Message CURSEM'), { target: { value: 'Use the saved key' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(String(init.body))).toMatchObject({ credentialMode: 'host' });
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
    expect(screen.getByText('proxy ready')).toBeInTheDocument();
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
