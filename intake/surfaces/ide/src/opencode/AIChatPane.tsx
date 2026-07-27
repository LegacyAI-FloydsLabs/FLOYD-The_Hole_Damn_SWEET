import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { usePlatform } from '@/platform';
import {
  PROVIDERS,
  ProviderHttpError,
  PolicyModelClient,
  setRuntimeModelConfig,
  subscribeRoutingDecisions,
  detectDialect,
  type ConversationMessage,
  type Dialect,
  type ProviderId,
  type RoutingPolicy,
} from '@/model-routing';
import { useEditorStore } from '@/store/editorStore';
import { useUIStore } from '@/store/uiStore';
import { AgentRunner, parseAgentPatch, parseContextSelectors } from '@/agent';
import type { AgentCheckpoint, AgentMemory, AgentPatchChange, AgentPatchPreview, AgentThread } from '@/platform';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

interface PendingProposal {
  preview: AgentPatchPreview;
  changes: AgentPatchChange[];
  selectedHunks: Record<string, string[]>;
  runId: string;
}

const SYSTEM_PROMPT = `You are the selected model running as CURSEM, the coding assistant inside CURSEM IDE.
Your goal is to help the user understand, debug, edit, and verify the open codebase. Be precise, candid, and implementation-oriented. Use supplied workspace and file context when relevant, and distinguish verified code facts from recommendations.`;
const EDIT_INSTRUCTIONS = `
When ready to change files, return proposed file changes inside exactly one <cursem-patch> JSON envelope with this shape: {"changes":[{"path":"workspace/relative/path","content":"complete replacement text"}]}. Use content:null only to delete a file. Do not put Markdown fences inside the envelope. Explain the change briefly before it. CURSEM validates every path, freezes current hashes, shows file and hunk review, and never applies changes without explicit user approval. Do not claim the patch was applied.`;
const TOOL_INSTRUCTIONS = `
You may inspect and verify the workspace by requesting exactly one tool at a time using <cursem-tool>{"id":"unique-id","name":"tool-name","arguments":{...}}</cursem-tool>. Available tools:
- search {query,limit?}: local repository path/symbol/text retrieval
- read_file {path,maxChars?}: bounded workspace file content
- list_dir {path?}: directory entries
- git_diff {path?}: current read-only Git diff
- rules {path?}: applied and available repository instructions
- run_task {executable,args,cwd?,timeoutMs?}: an approved no-shell task; allowed executables are node/npm/npx/pnpm/yarn/bun/git/rg/tsc/vite/vitest/pytest/python3/cargo/rustc/go/make
- mcp {server,tool,arguments}: call a connected MCP tool after explicit approval
Observe every tool result before deciding the next action. Use run_task to verify relevant work. Never claim a command passed unless its result has exitCode 0.`;
const AGENT_INSTRUCTIONS = `
The user selected Agent mode. Work autonomously but visibly until you have enough evidence to answer or propose a change.`;
const MAX_CONTEXT_CHARS = 32 * 1024;
const MAX_HISTORY_CHARS = 24 * 1024;

export function buildSystemPrompt({
  mode,
  workspaceRoot,
  activeTabPath,
  providerLabel,
  model,
}: {
  mode: 'ask' | 'edit' | 'agent';
  workspaceRoot: string;
  activeTabPath: string | null;
  providerLabel: string;
  model: string;
}): string {
  const ideContext = `

<ide_context>
Workspace root: ${workspaceRoot}
Active file: ${activeTabPath || 'none'}
Mode: ${mode}
Selected provider/model: ${providerLabel} / ${model}
</ide_context>`;
  if (mode === 'agent') return `${SYSTEM_PROMPT}${ideContext}${AGENT_INSTRUCTIONS}${TOOL_INSTRUCTIONS}${EDIT_INSTRUCTIONS}`;
  if (mode === 'edit') return `${SYSTEM_PROMPT}${ideContext}\nThe user selected Edit mode. Inspect the workspace as needed, then produce the requested change.${TOOL_INSTRUCTIONS}${EDIT_INSTRUCTIONS}`;
  return `${SYSTEM_PROMPT}${ideContext}`;
}

export function selectConversationHistory(messages: ChatMessage[], maxChars = MAX_HISTORY_CHARS): ConversationMessage[] {
  const selected: ConversationMessage[] = [];
  let remaining = Math.max(0, maxChars);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.pending || !message.content) continue;
    if (message.content.length > remaining) {
      if (selected.length === 0 && remaining > 80) {
        const marker = '\n...[earlier content omitted to bound provider context]...\n';
        const available = remaining - marker.length;
        const head = Math.floor(available / 3);
        selected.unshift({ role: message.role, content: `${message.content.slice(0, head)}${marker}${message.content.slice(-Math.max(0, available - head))}` });
      }
      break;
    }
    selected.unshift({ role: message.role, content: message.content });
    remaining -= message.content.length;
  }
  return selected;
}

function newId(): string {
  return crypto.randomUUID();
}

export function AIChatPane() {
  const { gateway, config } = usePlatform();
  const activeTabPath = useEditorStore((state) => state.activeTabPath);
  const cursor = useEditorStore((state) => state.cursor);
  const toggleAIChat = useUIStore((state) => state.toggleAIChat);
  const addToast = useUIStore((state) => state.addToast);
  const client = useMemo(() => new PolicyModelClient(), []);
  const [providerId, setProviderId] = useState<ProviderId>('anthropic');
  const [baseUrl, setBaseUrl] = useState(PROVIDERS.anthropic.baseUrl);
  const [model, setModel] = useState(PROVIDERS.anthropic.model);
  const [dialect, setDialect] = useState<Dialect>(PROVIDERS.anthropic.dialect);
  const [apiKey, setApiKey] = useState('');
  const [credentialMode, setCredentialMode] = useState<'user' | 'host'>('host');
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [includeContext, setIncludeContext] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [usage, setUsage] = useState<Record<string, number> | null>(null);
  const [mode, setMode] = useState<'ask' | 'edit' | 'agent'>('ask');
  const [proposal, setProposal] = useState<PendingProposal | null>(null);
  const [checkpoint, setCheckpoint] = useState<AgentCheckpoint | null>(null);
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [contextDisclosure, setContextDisclosure] = useState<{ items: Array<{ path: string; reason: string; chars: number }>; rules: string[]; totalChars: number } | null>(null);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [inlineCompletionEnabled, setInlineCompletionEnabled] = useState(true);
  const [routingPolicy, setRoutingPolicy] = useState<RoutingPolicy>('manual');
  const [routingDecision, setRoutingDecision] = useState<string>('Manual provider selection');
  const [requestPhase, setRequestPhase] = useState<'preparing' | 'connecting' | 'streaming' | null>(null);
  const [requestElapsedMs, setRequestElapsedMs] = useState(0);
  const requestStartedAtRef = useRef(0);
  const threadIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runnerRef = useRef<AgentRunner | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const resolvedDialect = useMemo(() => {
    try { return detectDialect({ providerId, baseUrl, model, dialect }); }
    catch { return dialect === 'anthropic' ? 'anthropic' : 'openai'; }
  }, [baseUrl, dialect, model, providerId]);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (!requestPhase) return;
    const timer = window.setInterval(() => setRequestElapsedMs(Math.round(performance.now() - requestStartedAtRef.current)), 100);
    return () => window.clearInterval(timer);
  }, [requestPhase]);
  useEffect(() => {
    const receiveContext = (event: Event) => {
      const content = (event as CustomEvent<{ content?: string }>).detail?.content;
      if (content) setInput((current) => `${current}${current ? '\n\n' : ''}<task_evidence>\n${content}\n</task_evidence>`);
    };
    window.addEventListener('cursem:agent-context', receiveContext);
    return () => window.removeEventListener('cursem:agent-context', receiveContext);
  }, []);
  useEffect(() => subscribeRoutingDecisions((decision) => {
    setRoutingDecision(`${decision.reason}: ${PROVIDERS[decision.providerId].label} · attempt ${decision.attempt}${decision.elapsedMs === undefined ? '' : ` · ${decision.elapsedMs}ms`}`);
  }), []);
  useEffect(() => {
    setRuntimeModelConfig({ providerId, baseUrl, model, dialect, apiKey, credentialMode, inlineCompletionEnabled, routingPolicy });
  }, [apiKey, baseUrl, credentialMode, dialect, inlineCompletionEnabled, model, providerId, routingPolicy]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([gateway.agentListThreads(), gateway.agentListCheckpoints(), gateway.agentListMemories()]).then(async ([available, checkpoints, savedMemories]) => {
      if (cancelled) return;
      setThreads(available);
      setCheckpoint(checkpoints[0] || null);
      setMemories(savedMemories);
    }).catch((error) => !cancelled && setLastError(formatClientError(error)));
    return () => { cancelled = true; };
  }, [gateway]);
  useEffect(() => {
    if (typeof messagesEndRef.current?.scrollIntoView === 'function') messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const changeProvider = useCallback((next: ProviderId) => {
    const provider = PROVIDERS[next];
    abortRef.current?.abort();
    setProviderId(next);
    setBaseUrl(provider.baseUrl);
    setModel(provider.model);
    setDialect(provider.dialect);
    setApiKey('');
    setCredentialMode('host');
    setLastError(null);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const steer = useCallback(() => {
    const message = input.trim();
    if (!message || !runnerRef.current || !activeRunIdRef.current) return;
    runnerRef.current.steer(message);
    setMessages((current) => [...current, { id: newId(), role: 'user', content: `Steer: ${message}` }]);
    setInput('');
    const currentThread = threadIdRef.current;
    if (currentThread) void gateway.agentAddMessage(currentThread, 'user', message, { steering: true, runId: activeRunIdRef.current }).catch(() => undefined);
    void gateway.agentAppendEvent(activeRunIdRef.current, 'run.steered', { message }).catch(() => undefined);
  }, [gateway, input]);

  const ensureThread = useCallback(async (title: string) => {
    if (threadIdRef.current) return threadIdRef.current;
    const thread = await gateway.agentCreateThread(title.slice(0, 80));
    threadIdRef.current = thread.id;
    setThreadId(thread.id);
    setThreads((current) => [thread, ...current]);
    return thread.id;
  }, [gateway]);

  const openThread = useCallback(async (id: string) => {
    if (sending || !id) return;
    const thread = await gateway.agentGetThread(id);
    threadIdRef.current = id;
    setThreadId(id);
    setMessages((thread.messages || []).filter((message) => message.role === 'user' || message.role === 'assistant').map((message) => ({ id: message.id, role: message.role as 'user' | 'assistant', content: message.content })));
    setProposal(null);
    setLastError(null);
  }, [gateway, sending]);

  const newThread = useCallback(async () => {
    stop();
    threadIdRef.current = null;
    setThreadId(null);
    setMessages([]);
    setProposal(null);
    setLastError(null);
  }, [stop]);

  const send = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || sending) return;
    if (credentialMode === 'user' && !apiKey.trim()) {
      setSettingsOpen(true);
      setLastError('Enter the provider API key. It remains in memory and is not saved.');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    requestStartedAtRef.current = performance.now();
    setRequestElapsedMs(0);
    setRequestPhase('preparing');
    setSending(true);
    setLastError(null);
    setUsage(null);
    setContextDisclosure(null);
    setProposal(null);
    const userMessage: ChatMessage = { id: newId(), role: 'user', content: prompt };
    const assistantId = newId();
    let activeRunId: string | null = null;
    setMessages((current) => [...current, userMessage, { id: assistantId, role: 'assistant', content: '', pending: true }]);
    setInput('');

    try {
      const activeThreadId = await ensureThread(prompt);
      await gateway.agentAddMessage(activeThreadId, 'user', prompt, { mode, activeTabPath });
      const run = await gateway.agentCreateRun(activeThreadId, providerId, model);
      activeRunId = run.id;
      activeRunIdRef.current = run.id;
      await gateway.agentAppendEvent(run.id, 'model.requested', { providerId, model, mode, activeTabPath, dialect: resolvedDialect });
      let contextBlock = '';
      let activeContextChars = 0;
      if (includeContext && activeTabPath) {
        try {
          const file = await gateway.readFile(activeTabPath);
          const clipped = file.length > MAX_CONTEXT_CHARS
            ? `${file.slice(0, MAX_CONTEXT_CHARS)}\n\n[Context truncated at ${MAX_CONTEXT_CHARS} characters]`
            : file;
          activeContextChars = Math.min(file.length, MAX_CONTEXT_CHARS);
          contextBlock = `\n\nActive file: ${activeTabPath}\nCursor: line ${cursor.line}, column ${cursor.column}\n\n<active_file>\n${clipped}\n</active_file>`;
        } catch (error) {
          contextBlock = `\n\nActive file path: ${activeTabPath}\nThe host could not read its contents: ${error instanceof Error ? error.message : 'unknown error'}`;
        }
      }

      if (includeContext) {
        const explicitSelectors = parseContextSelectors(prompt);
        let selectors = explicitSelectors;
        if (!selectors.length) {
          const results = await gateway.contextSearch(prompt, 3);
          selectors = results.map((result) => ({ type: 'file' as const, value: result.path }));
        }
        const resolved = selectors.length ? await gateway.contextResolve(selectors, 32 * 1024) : { items: [], totalChars: 0, budgetChars: 32 * 1024 };
        const relativeActivePath = activeTabPath?.startsWith(`${config.workspaceRoot}/`) ? activeTabPath.slice(config.workspaceRoot.length + 1) : activeTabPath || '';
        const ruleSet = await gateway.contextRules(relativeActivePath);
        const ruleBudget = 16 * 1024;
        let ruleChars = 0;
        const appliedRules = ruleSet.applied.flatMap((rule) => {
          const remaining = ruleBudget - ruleChars;
          if (remaining <= 0) return [];
          const content = rule.content.slice(0, remaining); ruleChars += content.length;
          return [{ ...rule, content }];
        });
        if (resolved.items.length) {
          contextBlock += `\n\n<repository_context>\n${resolved.items.map((item) => `<file path=${JSON.stringify(item.path)} reason=${JSON.stringify(item.reason)}>\n${item.content}\n</file>`).join('\n')}\n</repository_context>`;
        }
        if (appliedRules.length) {
          contextBlock += `\n\n<applied_rules>\n${appliedRules.map((rule) => `<rule path=${JSON.stringify(rule.path)}>\n${rule.content}\n</rule>`).join('\n')}\n</applied_rules>`;
        }
        if (memories.length) {
          const memoryContent = memories.map((memory) => `<memory id=${JSON.stringify(memory.id)}>\n${memory.content}\n</memory>`).join('\n');
          contextBlock += `\n\n<approved_project_memories>\n${memoryContent}\n</approved_project_memories>`;
          ruleChars += memoryContent.length;
        }
        setContextDisclosure({
          items: resolved.items.map((item) => ({ path: item.path, reason: item.reason, chars: item.chars })),
          rules: appliedRules.map((rule) => rule.path),
          totalChars: resolved.totalChars + ruleChars + activeContextChars,
        });
      }

      const conversation: ConversationMessage[] = [
        { role: 'system', content: buildSystemPrompt({
          mode,
          workspaceRoot: config.workspaceRoot,
          activeTabPath,
          providerLabel: PROVIDERS[providerId].label,
          model,
        }) },
        ...selectConversationHistory(messages),
        { role: 'user', content: `${prompt}${contextBlock}` },
      ];
      let assistantText = '';
      let finalUsage: Record<string, number> | null = null;
      let proposedFiles = 0;
      let firstTokenRecorded = false;
      const appendDelta = (text: string) => {
        if (text && !firstTokenRecorded) {
          firstTokenRecorded = true;
          const elapsedMs = Math.round(performance.now() - requestStartedAtRef.current);
          setRequestPhase('streaming');
          void gateway.agentAppendEvent(run.id, 'model.first_token', { elapsedMs }).catch(() => undefined);
        }
        setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: message.content + text } : message));
      };
      let toolCalls = 0;
      setRequestPhase('connecting');
      if (mode !== 'ask') {
        const runner = new AgentRunner(); runnerRef.current = runner;
        const result = await runner.run({
          gateway, client, runId: run.id, workspaceRoot: config.workspaceRoot,
          routing: { providerId, baseUrl, model, dialect, apiKey, credentialMode, routingPolicy }, messages: conversation,
          request: { maxTokens: 4096, temperature: 0.2 }, signal: controller.signal,
          onDelta: appendDelta,
          onUsage: (nextUsage) => { finalUsage = nextUsage; setUsage(nextUsage); },
          validateFinal: mode === 'edit' ? (text) => validateEditResponse(text, activeTabPath) : undefined,
        });
        assistantText = result.text; toolCalls = result.toolCalls; finalUsage = result.usage;
      } else {
        for await (const event of client.stream({ providerId, baseUrl, model, dialect, apiKey, credentialMode, routingPolicy }, { messages: conversation, maxTokens: 4096, temperature: 0.2 }, controller.signal)) {
          if (event.type === 'delta') { assistantText += event.text; appendDelta(event.text); }
          else if (event.type === 'usage') { finalUsage = event.usage; setUsage(event.usage); }
          else if (event.type === 'error') throw new Error(formatUnknownError(event.error));
        }
        if (!assistantText.trim()) throw new Error('The selected model completed without returning visible text. Choose a model that returns assistant content for this task.');
      }
      if (mode !== 'ask') {
        const parsed = parseAgentPatch(assistantText, activeTabPath);
        if (parsed) {
          proposedFiles = parsed.changes.length;
          const preview = await gateway.agentPreviewPatch(parsed.changes, run.id);
          setProposal({
            preview,
            changes: parsed.changes,
            runId: run.id,
            selectedHunks: Object.fromEntries(preview.files.map((file) => [file.path, file.hunks.map((hunk) => hunk.id)])),
          });
          await gateway.agentAppendEvent(run.id, 'patch.proposed', { proposalId: preview.proposalId, files: preview.files.map((file) => ({ path: file.path, operation: file.operation, hunks: file.hunks.length })) });
        } else setLastError('Edit mode completed without a <cursem-patch> proposal. No file was changed.');
      }
      await gateway.agentAddMessage(activeThreadId, 'assistant', assistantText, { runId: run.id, usage: finalUsage });
      await gateway.agentUpdateRun(run.id, 'completed', { usage: finalUsage, proposedFiles, toolCalls });
      setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, pending: false, content: message.content || assistantText } : message));
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = aborted ? 'Generation stopped.' : formatClientError(error);
      if (activeRunId) {
        void gateway.agentAppendEvent(activeRunId, aborted ? 'run.cancelled' : 'run.failed', { message }).catch(() => undefined);
        void gateway.agentUpdateRun(activeRunId, aborted ? 'cancelled' : 'failed', { message }).catch(() => undefined);
      }
      setLastError(aborted ? null : message);
      setMessages((current) => current.map((entry) => entry.id === assistantId
        ? { ...entry, pending: false, content: entry.content || message }
        : entry));
      if (!aborted) addToast(message, 'error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      runnerRef.current = null;
      activeRunIdRef.current = null;
      setSending(false);
      setRequestPhase(null);
      setRequestElapsedMs(0);
    }
  }, [activeTabPath, addToast, apiKey, baseUrl, client, config.workspaceRoot, credentialMode, cursor.column, cursor.line, dialect, ensureThread, gateway, includeContext, input, memories, messages, mode, model, providerId, resolvedDialect, routingPolicy, sending]);

  const saveMemory = useCallback(async () => {
    const content = memoryDraft.trim(); if (!content) return;
    try { const memory = await gateway.agentSaveMemory(content); setMemories((current) => [memory, ...current]); setMemoryDraft(''); }
    catch (error) { setLastError(formatClientError(error)); }
  }, [gateway, memoryDraft]);

  const deleteMemory = useCallback(async (id: string) => {
    try { await gateway.agentDeleteMemory(id); setMemories((current) => current.filter((memory) => memory.id !== id)); }
    catch (error) { setLastError(formatClientError(error)); }
  }, [gateway]);

  const applyProposal = useCallback(async () => {
    if (!proposal) return;
    const acceptedPaths = proposal.preview.files.filter((file) => (proposal.selectedHunks[file.path] || []).length > 0).map((file) => file.path);
    if (!acceptedPaths.length) { setLastError('Select at least one file or hunk to apply.'); return; }
    const approved = await gateway.confirmDestructive('apply reviewed AI transaction', acceptedPaths.join('\n'));
    if (!approved) return;
    try {
      const applied = await gateway.agentApplyPatch(proposal.preview.proposalId, acceptedPaths, `Agent run ${proposal.runId}`, proposal.selectedHunks);
      await gateway.agentAppendEvent(proposal.runId, 'patch.applied', { checkpointId: applied.checkpointId, files: acceptedPaths });
      const checkpoints = await gateway.agentListCheckpoints();
      setCheckpoint(checkpoints.find((item) => item.id === applied.checkpointId) || null);
      for (const path of acceptedPaths) {
        try {
          const content = await gateway.readFile(path);
          window.dispatchEvent(new CustomEvent('cursem:external-edit', { detail: { path, content } }));
        } catch { /* deleted files have no replacement content to dispatch */ }
      }
      setProposal(null);
      addToast(`Applied ${acceptedPaths.length} reviewed file${acceptedPaths.length === 1 ? '' : 's'}.`, 'success');
    } catch (error) {
      setLastError(formatClientError(error));
    }
  }, [addToast, gateway, proposal]);

  const undoCheckpoint = useCallback(async () => {
    if (!checkpoint) return;
    try {
      const restored = await gateway.agentRestoreCheckpoint(checkpoint.id);
      for (const file of restored.files) {
        try {
          const content = await gateway.readFile(file.path);
          window.dispatchEvent(new CustomEvent('cursem:external-edit', { detail: { path: file.path, content } }));
        } catch { /* restoration may remove a file created by the Agent */ }
      }
      addToast(`Restored ${restored.files.length} file${restored.files.length === 1 ? '' : 's'} from checkpoint.`, 'success');
      setCheckpoint(null);
    } catch (error) {
      setLastError(formatClientError(error));
    }
  }, [addToast, checkpoint, gateway]);

  const toggleHunk = useCallback((path: string, hunkId: string) => {
    setProposal((current) => {
      if (!current) return current;
      const selected = new Set(current.selectedHunks[path] || []);
      if (selected.has(hunkId)) selected.delete(hunkId); else selected.add(hunkId);
      return { ...current, selectedHunks: { ...current.selectedHunks, [path]: Array.from(selected) } };
    });
  }, []);

  return (
    <aside className="ai-chat-pane" aria-label="CURSEM coding partner">
      <header className="ai-chat-header">
        <div className="ai-chat-title"><p className="eyebrow">CODING PARTNER</p><strong>CURSEM</strong><span>{PROVIDERS[providerId].label}</span></div>
        <div className="ai-header-actions">
          <select className="thread-picker" aria-label="Conversation history" value={threadId || ''} onChange={(event) => void openThread(event.target.value)} disabled={sending}>
            <option value="">New conversation</option>
            {threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
          </select>
          <button className="icon-button compact" onClick={() => void newThread()} aria-label="New conversation" disabled={sending}>+</button>
          <span className={`connection-label ${sending ? 'connected' : apiKey || credentialMode === 'host' ? 'ready' : 'offline'}`}>{requestPhase ? `${requestPhase} · ${(requestElapsedMs / 1000).toFixed(1)}s` : credentialMode === 'host' ? 'proxy ready' : apiKey ? 'ready' : 'key required'}</span>
          <button className={`icon-button compact ${settingsOpen ? 'active' : ''}`} onClick={() => setSettingsOpen((open) => !open)} aria-label="Model routing settings" aria-pressed={settingsOpen}><Icon name="settings" size={15} /></button>
          <button className="icon-button compact" onClick={toggleAIChat} aria-label="Close coding partner"><Icon name="close" size={15} /></button>
        </div>
      </header>

      {settingsOpen && (
        <section className="model-routing-settings" aria-label="Model routing settings">
          <div className="routing-grid">
            <label><span>Provider</span><select aria-label="Provider" value={providerId} onChange={(event) => changeProvider(event.target.value as ProviderId)}>{Object.values(PROVIDERS).map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
            <label><span>Dialect</span><select aria-label="Dialect" value={dialect} onChange={(event) => setDialect(event.target.value as Dialect)}><option value="auto">Auto detect</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label>
            <label><span>Mode</span><select aria-label="Mode" value={mode} onChange={(event) => setMode(event.target.value as 'ask' | 'edit' | 'agent')}><option value="ask">Ask</option><option value="edit" disabled={!activeTabPath}>Edit active file</option><option value="agent">Agent</option></select></label>
            <label><span>Routing</span><select aria-label="Routing" value={routingPolicy} onChange={(event) => setRoutingPolicy(event.target.value as RoutingPolicy)}><option value="manual">Manual</option><option value="cost-first">Low-cost first</option><option value="latency-first">Fastest measured</option><option value="resilient">Resilient fallback</option></select></label>
          </div>
          <label><span>Model</span><input aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} autoComplete="off" /></label>
          <label><span>API base URL</span><input aria-label="API base URL" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} autoComplete="url" /></label>
          <label><span>Provider API key</span><input aria-label="Provider API key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={credentialMode === 'host' ? 'Owned by the local credential proxy' : 'Held in memory only'} disabled={credentialMode === 'host'} autoComplete="off" /></label>
          <label className="host-credential-toggle"><input aria-label="Use credential proxy" type="checkbox" checked={credentialMode === 'host'} onChange={(event) => setCredentialMode(event.target.checked ? 'host' : 'user')} /><span>Use credential proxy</span></label>
          <label className="host-credential-toggle"><input aria-label="Enable provider-routed CURSEM Tab ghost text" type="checkbox" checked={inlineCompletionEnabled} onChange={(event) => setInlineCompletionEnabled(event.target.checked)} /><span>Enable provider-routed CURSEM Tab ghost text</span></label>
          <details className="memory-manager"><summary>Approved project memory ({memories.length})</summary><div className="memory-entry"><input aria-label="New approved project memory" value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} maxLength={4000} placeholder="A rule or decision to reuse in future threads" /><button className="button ghost" onClick={() => void saveMemory()} disabled={!memoryDraft.trim()}>Save</button></div>{memories.map((memory) => <div className="saved-memory" key={memory.id}><span>{memory.content}</span><button className="text-button" onClick={() => void deleteMemory(memory.id)}>Delete</button></div>)}</details>
          <footer><span className={`dialect-chip ${resolvedDialect}`}>{resolvedDialect} protocol</span><small>{routingDecision}. Policy fallback uses proxy-managed requests only; user keys stay on their selected endpoint.</small><small>Every request uses the local /gateway relay. Provider credentials remain in the credential proxy; manually entered keys remain memory-only.</small></footer>
        </section>
      )}

      <div className="context-strip">
        <Icon name="files" size={14} />
        <span>{activeTabPath ? activeTabPath.split('/').pop() : 'No active file'}</span>
        <label><input type="checkbox" checked={includeContext} onChange={(event) => setIncludeContext(event.target.checked)} /> include context</label>
        {contextDisclosure && <details className="context-inspector"><summary>{contextDisclosure.items.length} files · {contextDisclosure.rules.length} rules · {contextDisclosure.totalChars.toLocaleString()} chars</summary><div>{contextDisclosure.items.map((item) => <span key={`${item.path}:${item.reason}`}><strong>{item.path}</strong> — {item.reason} ({item.chars.toLocaleString()} chars)</span>)}{contextDisclosure.rules.map((rule) => <span key={rule}><strong>{rule}</strong> — applied instruction</span>)}</div></details>}
      </div>

      <div className="ai-chat-messages" aria-live="polite">
        {messages.length === 0 && <div className="ai-empty"><div className="ai-orb"><Icon name="spark" size={28} /></div><strong>Build with CURSEM</strong><p>Ask for analysis or switch to Edit mode for a review-gated active-file change. Provider failures are shown without rewriting them.</p><div className="ai-capabilities"><span>Active-file context</span><span>Review-gated edits</span><span>Unified streaming</span><span>Stop propagation</span></div></div>}
        {messages.map((message) => message.pending && !message.content ? null : <article key={message.id} className={`chat-message ${message.role} ${message.pending ? 'pending' : ''}`}><header>{message.role === 'user' ? 'You' : 'CURSEM'}{message.pending && <span>streaming</span>}</header><div>{displayMessage(message.content)}</div></article>)}
        <div ref={messagesEndRef} />
      </div>

      {proposal && <section className="edit-proposal multi-file-review" role="status" aria-label="Review proposed changes">
        <header><div><strong>Review proposed changes</strong><span>{proposal.preview.files.length} file{proposal.preview.files.length === 1 ? '' : 's'} · durable checkpoint on apply</span></div><div><button className="button ghost" onClick={() => setProposal(null)}>Dismiss</button><button className="button primary" onClick={() => void applyProposal()}>Apply selected</button></div></header>
        <div className="proposal-files">{proposal.preview.files.map((file) => <article key={file.path} className="proposal-file">
          <div className="proposal-file-title"><strong>{file.path}</strong><span>{file.operation} · {file.stats.delta >= 0 ? '+' : ''}{file.stats.delta} lines</span></div>
          {file.hunks.map((hunk) => <label className="proposal-hunk" key={hunk.id}>
            <input type="checkbox" checked={(proposal.selectedHunks[file.path] || []).includes(hunk.id)} onChange={() => toggleHunk(file.path, hunk.id)} />
            <details><summary>{hunk.id} · -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}</summary><pre>{[...hunk.beforeLines.map((line) => `- ${line}`), ...hunk.afterLines.map((line) => `+ ${line}`)].join('\n')}</pre></details>
          </label>)}
        </article>)}</div>
      </section>}
      {checkpoint && !proposal && <div className="checkpoint-strip"><span>Durable checkpoint: {checkpoint.label}</span><button className="text-button" onClick={() => void undoCheckpoint()}>Restore checkpoint</button></div>}
      {lastError && <div className="provider-error" role="alert"><Icon name="warning" size={15} /><div><strong>Provider error</strong><span>{lastError}</span></div></div>}
      {usage && <div className="usage-strip">{Object.entries(usage).map(([name, value]) => <span key={name}>{name.replaceAll('_', ' ')}: {value}</span>)}</div>}

      <div className="ai-chat-input">
        <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (sending && mode === 'agent') steer(); else void send(); } }} placeholder={sending && mode === 'agent' ? 'Steer the active Agent run…' : activeTabPath ? `${mode === 'edit' ? 'Edit' : mode === 'agent' ? 'Agent task for' : 'Ask about'} ${activeTabPath.split('/').pop()} · @file:path @folder:path @symbol:name` : 'Ask CURSEM about the codebase · @file:path @folder:path @symbol:name'} aria-label="Message CURSEM" />
        <div className="composer-footer"><span>{sending && mode === 'agent' ? 'Enter interrupts and steers; Stop cancels the run' : 'Enter sends; Shift+Enter adds a line'}</span><div>{messages.length > 0 && <button className="button ghost" onClick={() => void newThread()} disabled={sending}>New thread</button>}{sending ? <>{mode === 'agent' && <button className="button primary" onClick={steer} disabled={!input.trim()}>Steer now</button>}<button className="button danger" onClick={stop}><Icon name="stop" size={13} /> Stop</button></> : <button className="button primary send-button" onClick={() => void send()} disabled={!input.trim()}><Icon name="upload" size={13} /> Send</button>}</div></div>
      </div>
    </aside>
  );
}

function formatUnknownError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') return String((error as Record<string, unknown>).message);
  try { return JSON.stringify(error); } catch { return 'Unknown provider stream error.'; }
}

function displayMessage(content: string): string {
  return content
    .replace(/<cursem-patch>[\s\S]*?<\/cursem-patch>/gi, '\n[Typed patch ready for review]\n')
    .replace(/<cursem-tool>([\s\S]*?)<\/cursem-tool>/gi, (_match, raw: string) => {
      try { const tool = JSON.parse(raw) as { name?: string }; return `\n[Tool requested: ${tool.name || 'unknown'}]\n`; }
      catch { return '\n[Tool request]\n'; }
    })
    .trim();
}

function formatClientError(error: unknown): string {
  if (error instanceof ProviderHttpError) return `${error.status} ${error.statusText}: ${error.message}`;
  return error instanceof Error ? error.message : 'Message could not be sent.';
}

function validateEditResponse(text: string, activePath: string | null): string | null {
  try {
    return parseAgentPatch(text, activePath)
      ? null
      : 'Edit mode requires exactly one valid <cursem-patch> proposal before completion.';
  } catch (error) {
    return error instanceof Error ? error.message : 'Edit mode returned an invalid patch proposal.';
  }
}
