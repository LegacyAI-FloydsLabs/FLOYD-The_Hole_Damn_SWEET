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
import {
  DRAFT_THREAD_KEY,
  useChatStore,
  type ChatMessage,
  type PlanState,
  type ThreadChatSlice,
} from '@/store/chatStore';
import { AgentRunner, fetchInstalledSkillsPrompt, parseAgentPatch, parseAgentPlan, parseContextSelectors, type AgentAskResponse } from '@/agent';
import { AskUserCard, ChatMessageRow, PlanCard, SessionSidebar, ToolCard } from '@/components/chat';
import type { AgentCheckpoint, AgentMemory, AgentPatchChange, AgentPatchPreview } from '@/platform';

interface PendingProposal {
  preview: AgentPatchPreview;
  changes: AgentPatchChange[];
  selectedHunks: Record<string, string[]>;
  runId: string;
}

type ProviderOption = (typeof PROVIDERS)[ProviderId];

interface ModelOption {
  id: string;
  name: string;
}

const EMPTY_SLICE: ThreadChatSlice = { messages: [], running: false, streamingPhase: null, usage: null, toolCalls: [], pendingRequest: null, plan: null };

// Ecosystem policy: GLM (zai) is the default route whenever the user has no
// persisted provider+model selection of their own.
const DEFAULT_PROVIDER_ID: ProviderId = 'zai';

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
Observe every tool result before deciding the next action. Use run_task to verify relevant work. Never claim a command passed unless its result has exitCode 0.
If you need a decision or missing information from the user to proceed, emit exactly one <cursem-ask>{"id":"unique-id","method":"select|confirm|input","question":"...","options":["choice A","choice B"]}</cursem-ask> envelope (options only for select) and stop; CURSEM will present the question and return the answer as an <ask-response>.`;
const AGENT_INSTRUCTIONS = `
The user selected Agent mode. Work autonomously but visibly until you have enough evidence to answer or propose a change.`;
const PLAN_INSTRUCTIONS = `
The user enabled Plan mode. Work READ-ONLY: use tools to inspect and verify, but never emit <cursem-patch> and never modify files. When the investigation is complete, respond with exactly one <cursem-plan>{"summary":"one-paragraph plan summary","steps":["step 1","step 2"]}</cursem-plan> JSON envelope, then stop. The user reviews the plan before any implementation happens.`;
const MAX_CONTEXT_CHARS = 32 * 1024;
const MAX_HISTORY_CHARS = 24 * 1024;

export function buildSystemPrompt({
  mode,
  workspaceRoot,
  activeTabPath,
  providerLabel,
  model,
  planMode = false,
  skillsPrompt = '',
}: {
  mode: 'ask' | 'edit' | 'agent';
  workspaceRoot: string;
  activeTabPath: string | null;
  providerLabel: string;
  model: string;
  planMode?: boolean;
  skillsPrompt?: string;
}): string {
  const ideContext = `

<ide_context>
Workspace root: ${workspaceRoot}
Active file: ${activeTabPath || 'none'}
Mode: ${planMode ? 'plan' : mode}
Selected provider/model: ${providerLabel} / ${model}
</ide_context>`;
  if (planMode && mode !== 'ask') return `${SYSTEM_PROMPT}${ideContext}${AGENT_INSTRUCTIONS}${TOOL_INSTRUCTIONS}${PLAN_INSTRUCTIONS}${skillsPrompt}`;
  if (mode === 'agent') return `${SYSTEM_PROMPT}${ideContext}${AGENT_INSTRUCTIONS}${TOOL_INSTRUCTIONS}${EDIT_INSTRUCTIONS}${skillsPrompt}`;
  if (mode === 'edit') return `${SYSTEM_PROMPT}${ideContext}\nThe user selected Edit mode. Inspect the workspace as needed, then produce the requested change.${TOOL_INSTRUCTIONS}${EDIT_INSTRUCTIONS}${skillsPrompt}`;
  return `${SYSTEM_PROMPT}${ideContext}${skillsPrompt}`;
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
  const persistedProviderId = useUIStore((state) => state.aiProviderId);
  const persistedModel = useUIStore((state) => state.aiModel);
  const setAIModelSelection = useUIStore((state) => state.setAIModelSelection);
  const activeKey = useChatStore((state) => state.activeKey);
  const slice = useChatStore((state) => state.slices[state.activeKey]) || EMPTY_SLICE;
  const runningKey = useChatStore((state) => state.runningKey);
  const threads = useChatStore((state) => state.threads);
  const threadId = activeKey === DRAFT_THREAD_KEY ? null : activeKey;
  const sending = slice.running;
  const requestPhase = slice.streamingPhase;
  const usage = slice.usage;
  const client = useMemo(() => new PolicyModelClient(), []);
  const [vaultProviders, setVaultProviders] = useState<ProviderOption[]>([]);
  const [vaultReady, setVaultReady] = useState(false);
  const bootProviderId: ProviderId = persistedProviderId && persistedProviderId in PROVIDERS ? persistedProviderId as ProviderId : DEFAULT_PROVIDER_ID;
  const [providerId, setProviderId] = useState<ProviderId>(bootProviderId);
  const [baseUrl, setBaseUrl] = useState(PROVIDERS[bootProviderId].baseUrl);
  const [model, setModel] = useState(persistedModel || PROVIDERS[bootProviderId].model);
  const [dialect, setDialect] = useState<Dialect>(PROVIDERS[bootProviderId].dialect);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [coreRestore, setCoreRestore] = useState<{ modelRoute: { provider: string; model: string } | null } | null>(null);
  const [draftSyncReady, setDraftSyncReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [includeContext, setIncludeContext] = useState(true);
  const [input, setInput] = useState('');
  const [lastError, setLastError] = useState<string | null>(null);
  const [mode, setMode] = useState<'ask' | 'edit' | 'agent'>('ask');
  const [planMode, setPlanMode] = useState(false);
  const [proposal, setProposal] = useState<PendingProposal | null>(null);
  const [checkpoint, setCheckpoint] = useState<AgentCheckpoint | null>(null);
  const [contextDisclosure, setContextDisclosure] = useState<{ items: Array<{ path: string; reason: string; chars: number }>; rules: string[]; totalChars: number } | null>(null);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [inlineCompletionEnabled, setInlineCompletionEnabled] = useState(true);
  const [routingPolicy, setRoutingPolicy] = useState<RoutingPolicy>('manual');
  const [routingDecision, setRoutingDecision] = useState<string>('Manual provider selection');
  const [requestElapsedMs, setRequestElapsedMs] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const requestStartedAtRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const runnerRef = useRef<AgentRunner | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const askResolveRef = useRef<((response: AgentAskResponse) => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // True while the visible model is only a seed (first run or a re-seeded
  // provider), so the first live entry replaces the static default.
  const modelSeedPendingRef = useRef(!(persistedProviderId && persistedModel));
  const coreRouteAppliedRef = useRef(false);
  const selectedProvider = vaultProviders.find((provider) => provider.id === providerId) || PROVIDERS[providerId];

  const resolvedDialect = useMemo(() => {
    try { return detectDialect({ providerId, baseUrl, model, dialect }); }
    catch { return dialect === 'anthropic' ? 'anthropic' : 'openai'; }
  }, [baseUrl, dialect, model, providerId]);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/vault/catalog', { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Vault catalog HTTP ${response.status}`);
        return response.json();
      })
      .then((catalog) => {
        if (cancelled) return;
        const proxyUrl = String(catalog.proxyUrl || '').replace(/\/+$/, '');
        const available = (Array.isArray(catalog.providers) ? catalog.providers : [])
          .filter((provider: { id?: string; configured?: boolean; protocol?: string }) =>
            provider.configured === true
            && typeof provider.id === 'string'
            && provider.id in PROVIDERS
            && /openai|anthropic|responses/.test(String(provider.protocol || '')))
          .map((provider: { id: ProviderId; proxyPath: string; models?: string[] }) => {
            const fallback = PROVIDERS[provider.id];
            return {
              ...fallback,
              baseUrl: `${proxyUrl}${provider.proxyPath}`,
              model: provider.models?.[0] || fallback.model,
            };
          });
        setVaultProviders(available);
        setVaultReady(available.length > 0);
        if (available.length && !available.some((provider: ProviderOption) => provider.id === providerId)) {
          // The visible provider is not Vault-configured (first run or a stale
          // persisted selection): re-seed to the GLM route and let the live
          // model list replace the static default below.
          const seed = available.find((provider: ProviderOption) => provider.id === DEFAULT_PROVIDER_ID) || available[0];
          modelSeedPendingRef.current = true;
          setProviderId(seed.id);
          setBaseUrl(seed.baseUrl);
          setModel(seed.model);
          setDialect(seed.dialect);
        }
        if (!available.length) setLastError('Vault has no configured provider route available to CURSEM.');
      })
      .catch((error) => {
        if (!cancelled) {
          setVaultReady(false);
          setLastError(error instanceof Error ? error.message : 'Vault catalog unavailable');
        }
      });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    void fetch(`/api/models?provider=${encodeURIComponent(providerId)}`, { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`);
        return response.json();
      })
      .then((payload: { models?: Array<{ id?: unknown; name?: unknown }> }) => {
        if (cancelled) return;
        const options = (Array.isArray(payload?.models) ? payload.models : [])
          .filter((entry): entry is { id: string; name?: unknown } => Boolean(entry && typeof entry.id === 'string' && entry.id))
          .map((entry) => ({ id: entry.id, name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id }));
        const seedPending = modelSeedPendingRef.current;
        modelSeedPendingRef.current = false;
        setModelOptions(options);
        setModel((current) => !seedPending && options.some((option) => option.id === current) ? current : options[0]?.id || PROVIDERS[providerId].model);
      })
      .catch(() => {
        if (cancelled) return;
        modelSeedPendingRef.current = false;
        const fallback = PROVIDERS[providerId].model;
        setModelOptions(fallback ? [{ id: fallback, name: fallback }] : []);
        setModel((current) => current || fallback);
      })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [providerId]);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/core/experience', { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Core experience HTTP ${response.status}`);
        return response.json();
      })
      .then((slice: { available?: boolean; modelRoute?: { provider?: unknown; model?: unknown } | null; composerDraft?: unknown }) => {
        if (cancelled || !slice?.available) return;
        const composerDraft = typeof slice.composerDraft === 'string' ? slice.composerDraft : '';
        if (composerDraft) setInput((current) => current || composerDraft);
        const route = slice.modelRoute;
        if (route && typeof route.provider === 'string' && typeof route.model === 'string') setCoreRestore({ modelRoute: { provider: route.provider, model: route.model } });
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setDraftSyncReady(true); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (coreRouteAppliedRef.current || !coreRestore?.modelRoute || !vaultProviders.length) return;
    coreRouteAppliedRef.current = true;
    const route = coreRestore.modelRoute;
    const provider = vaultProviders.find((candidate) => candidate.id === route.provider);
    if (!provider) return;
    // A Core-restored route is an explicit cross-surface selection, not a seed.
    modelSeedPendingRef.current = false;
    setProviderId(provider.id);
    setBaseUrl(provider.baseUrl);
    setModel(route.model);
    setDialect(provider.dialect);
  }, [coreRestore, vaultProviders]);
  useEffect(() => {
    setAIModelSelection(providerId, model);
    void fetch('/api/core/experience/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelRoute: { provider: providerId, model } }),
    }).catch(() => undefined);
  }, [model, providerId, setAIModelSelection]);
  useEffect(() => {
    if (!draftSyncReady) return;
    const draft = input;
    const timer = window.setTimeout(() => {
      void fetch('/api/core/experience/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ composerDraft: draft }),
      }).then(async (response) => {
        if (response.status !== 409) return;
        // Preserve-and-re-read: adopt the authoritative draft only when the
        // user has not typed over it since this publish was queued.
        const slice = await response.json().catch(() => null);
        if (slice && typeof slice.composerDraft === 'string') setInput((current) => current === draft ? slice.composerDraft : current);
      }).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [input, draftSyncReady]);
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
    setRuntimeModelConfig({ providerId, baseUrl, model, dialect, inlineCompletionEnabled, routingPolicy });
  }, [baseUrl, dialect, inlineCompletionEnabled, model, providerId, routingPolicy]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([gateway.agentListThreads(), gateway.agentListCheckpoints(), gateway.agentListMemories()]).then(async ([available, checkpoints, savedMemories]) => {
      if (cancelled) return;
      useChatStore.getState().setThreads(available);
      setCheckpoint(checkpoints[0] || null);
      setMemories(savedMemories);
    }).catch((error) => !cancelled && setLastError(formatClientError(error)));
    return () => { cancelled = true; };
  }, [gateway]);
  useEffect(() => {
    if (typeof messagesEndRef.current?.scrollIntoView === 'function') messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [slice.messages]);

  const changeProvider = useCallback((next: ProviderId) => {
    const provider = vaultProviders.find((candidate) => candidate.id === next);
    if (!provider) return;
    abortRef.current?.abort();
    setProviderId(next);
    setBaseUrl(provider.baseUrl);
    setModel(provider.model);
    setDialect(provider.dialect);
    setLastError(null);
  }, [vaultProviders]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Release a runner paused on <cursem-ask> so the run unwinds as cancelled.
    askResolveRef.current?.({ cancelled: true });
    askResolveRef.current = null;
    const state = useChatStore.getState();
    if (state.activeKey !== DRAFT_THREAD_KEY || state.slices[state.activeKey]?.pendingRequest) {
      state.setPendingRequest(state.activeKey, null);
    }
  }, []);

  const steer = useCallback(() => {
    const message = input.trim();
    if (!message || !runnerRef.current || !activeRunIdRef.current) return;
    runnerRef.current.steer(message);
    const state = useChatStore.getState();
    state.appendMessage(state.activeKey, { id: newId(), role: 'user', content: `Steer: ${message}` });
    setInput('');
    const currentThread = state.activeKey;
    if (currentThread !== DRAFT_THREAD_KEY) void gateway.agentAddMessage(currentThread, 'user', message, { steering: true, runId: activeRunIdRef.current }).catch(() => undefined);
    void gateway.agentAppendEvent(activeRunIdRef.current, 'run.steered', { message }).catch(() => undefined);
  }, [gateway, input]);

  const ensureThread = useCallback(async (title: string) => {
    const state = useChatStore.getState();
    if (state.activeKey !== DRAFT_THREAD_KEY) return state.activeKey;
    const thread = await gateway.agentCreateThread(title.slice(0, 80));
    state.upsertThread(thread);
    state.migrateKey(DRAFT_THREAD_KEY, thread.id);
    return thread.id;
  }, [gateway]);

  const openThread = useCallback(async (id: string) => {
    if (useChatStore.getState().runningKey || !id) return;
    const thread = await gateway.agentGetThread(id);
    const messages: ChatMessage[] = (thread.messages || [])
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ id: message.id, role: message.role as 'user' | 'assistant', content: message.content }));
    // Historical plan cards render read-only: the plan was consumed (or
    // abandoned) in a past session and can never be acted on twice.
    let plan: PlanState | null = null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role !== 'assistant') continue;
      try {
        const parsed = parseAgentPlan(messages[index].content);
        if (parsed) { plan = { ...parsed, locked: true }; break; }
      } catch { /* malformed historical envelopes are display-only */ }
    }
    const state = useChatStore.getState();
    state.loadThread(id, messages, plan);
    state.setActiveKey(id);
    setProposal(null);
    setLastError(null);
  }, [gateway]);

  const newThread = useCallback(async () => {
    stop();
    const state = useChatStore.getState();
    state.loadThread(DRAFT_THREAD_KEY, []);
    state.setActiveKey(DRAFT_THREAD_KEY);
    setProposal(null);
    setLastError(null);
  }, [stop]);

  const deleteThread = useCallback((id: string) => {
    const state = useChatStore.getState();
    const wasActive = state.activeKey === id;
    void gateway.agentDeleteThread(id).then(() => {
      state.hideThread(id);
      if (wasActive) void newThread();
      addToast('Conversation deleted.', 'info');
    }).catch(() => {
      addToast('Could not delete the conversation on the server.', 'error');
    });
  }, [addToast, gateway, newThread]);

  const send = useCallback(async (overridePrompt?: string) => {
    const prompt = (overridePrompt ?? input).trim();
    if (!prompt || sending || !vaultReady) return;
    const state = useChatStore.getState();
    const draftKey = state.activeKey;
    const historySource = [...(state.slices[draftKey]?.messages || [])];
    const controller = new AbortController();
    abortRef.current = controller;
    requestStartedAtRef.current = performance.now();
    setRequestElapsedMs(0);
    state.setPhase(draftKey, 'preparing');
    state.setRunning(draftKey, true);
    setLastError(null);
    state.setUsage(draftKey, null);
    setContextDisclosure(null);
    setProposal(null);
    const userMessage: ChatMessage = { id: newId(), role: 'user', content: prompt };
    const assistantId = newId();
    let activeRunId: string | null = null;
    let sliceKey = draftKey;
    state.appendMessage(draftKey, userMessage);
    state.appendMessage(draftKey, { id: assistantId, role: 'assistant', content: '', pending: true });
    setInput('');

    // Plan mode forces the autonomous tool loop even from Ask mode, but with
    // read-only plan instructions instead of the patch protocol.
    const effectiveMode: 'ask' | 'edit' | 'agent' = planMode && mode === 'ask' ? 'agent' : mode;

    try {
      const activeThreadId = await ensureThread(prompt);
      sliceKey = activeThreadId;
      await gateway.agentAddMessage(activeThreadId, 'user', prompt, { mode: planMode ? 'plan' : mode, activeTabPath });
      const run = await gateway.agentCreateRun(activeThreadId, providerId, model);
      activeRunId = run.id;
      activeRunIdRef.current = run.id;
      await gateway.agentAppendEvent(run.id, 'model.requested', { providerId, model, mode: planMode ? 'plan' : mode, activeTabPath, dialect: resolvedDialect });
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

      // Skills installed into the workspace's .cursem/skills target are
      // appended to the system prompt; any failure yields no injection.
      const skillsPrompt = await fetchInstalledSkillsPrompt();

      const store = useChatStore.getState();
      const conversation: ConversationMessage[] = [
        { role: 'system', content: buildSystemPrompt({
          mode: effectiveMode,
          workspaceRoot: config.workspaceRoot,
          activeTabPath,
          providerLabel: selectedProvider.label,
          model,
          planMode,
          skillsPrompt,
        }) },
        ...selectConversationHistory(historySource),
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
          store.setPhase(sliceKey, 'streaming');
          void gateway.agentAppendEvent(run.id, 'model.first_token', { elapsedMs }).catch(() => undefined);
        }
        store.appendMessageText(sliceKey, assistantId, text);
      };
      const noteFallback = (requestedProvider: string, servedModel: string) => {
        store.updateMessage(sliceKey, assistantId, { fallback: { requestedProvider, model: servedModel } });
        void gateway.agentAppendEvent(run.id, 'model.fallback', { requestedProviderId: requestedProvider, servedModel }).catch(() => undefined);
      };
      let toolCalls = 0;
      store.setPhase(sliceKey, 'connecting');
      if (effectiveMode !== 'ask') {
        const runner = new AgentRunner(); runnerRef.current = runner;
        const result = await runner.run({
          gateway, client, runId: run.id, workspaceRoot: config.workspaceRoot,
          routing: { providerId, baseUrl, model, dialect, routingPolicy }, messages: conversation,
          request: { maxTokens: 4096, temperature: 0.2 }, signal: controller.signal,
          onDelta: appendDelta,
          onUsage: (nextUsage) => { finalUsage = nextUsage; store.setUsage(sliceKey, nextUsage); },
          onFallback: noteFallback,
          onToolEvent: (event) => useChatStore.getState().applyToolEvent(sliceKey, event),
          askUser: (request) => new Promise<AgentAskResponse>((resolve) => {
            askResolveRef.current = resolve;
            useChatStore.getState().setPendingRequest(sliceKey, request);
          }),
          validateFinal: planMode
            ? (text) => validatePlanResponse(text)
            : effectiveMode === 'edit' ? (text) => validateEditResponse(text, activeTabPath) : undefined,
        });
        assistantText = result.text; toolCalls = result.toolCalls; finalUsage = result.usage;
      } else {
        for await (const event of client.stream({ providerId, baseUrl, model, dialect, routingPolicy }, { messages: conversation, maxTokens: 4096, temperature: 0.2 }, controller.signal)) {
          if (event.type === 'delta') { assistantText += event.text; appendDelta(event.text); }
          else if (event.type === 'usage') { finalUsage = event.usage; store.setUsage(sliceKey, event.usage); }
          else if (event.type === 'fallback') noteFallback(event.requestedProvider, event.model);
          else if (event.type === 'error') throw new Error(formatUnknownError(event.error));
        }
        if (!assistantText.trim()) throw new Error('The selected model completed without returning visible text. Choose a model that returns assistant content for this task.');
      }
      if (planMode && effectiveMode !== 'ask') {
        try {
          const plan = parseAgentPlan(assistantText);
          if (plan) {
            store.setPlan(sliceKey, { ...plan, locked: false });
            await gateway.agentAppendEvent(run.id, 'plan.proposed', { summary: plan.summary, steps: plan.steps.length });
          } else setLastError('Plan mode completed without a <cursem-plan> proposal.');
        } catch (error) {
          setLastError(error instanceof Error ? error.message : 'Plan mode returned an invalid plan proposal.');
        }
      } else if (effectiveMode !== 'ask') {
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
        } else if (effectiveMode === 'edit') setLastError('Edit mode completed without a <cursem-patch> proposal. No file was changed.');
      }
      await gateway.agentAddMessage(activeThreadId, 'assistant', assistantText, { runId: run.id, usage: finalUsage });
      await gateway.agentUpdateRun(run.id, 'completed', { usage: finalUsage, proposedFiles, toolCalls });
      store.updateMessage(sliceKey, assistantId, { pending: false, content: assistantText });
      store.attachTools(sliceKey, assistantId);
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = aborted ? 'Generation stopped.' : formatClientError(error);
      if (activeRunId) {
        void gateway.agentAppendEvent(activeRunId, aborted ? 'run.cancelled' : 'run.failed', { message }).catch(() => undefined);
        void gateway.agentUpdateRun(activeRunId, aborted ? 'cancelled' : 'failed', { message }).catch(() => undefined);
      }
      setLastError(aborted ? null : message);
      const store = useChatStore.getState();
      const current = store.slices[sliceKey]?.messages.find((entry) => entry.id === assistantId);
      store.updateMessage(sliceKey, assistantId, { pending: false, content: current?.content || message });
      store.attachTools(sliceKey, assistantId);
      store.setPendingRequest(sliceKey, null);
      askResolveRef.current = null;
      if (!aborted) addToast(message, 'error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      runnerRef.current = null;
      activeRunIdRef.current = null;
      const store = useChatStore.getState();
      store.setRunning(sliceKey, false);
      store.setPhase(sliceKey, null);
      setRequestElapsedMs(0);
    }
  }, [activeTabPath, addToast, baseUrl, client, config.workspaceRoot, cursor.column, cursor.line, dialect, ensureThread, gateway, includeContext, input, memories, mode, model, planMode, providerId, resolvedDialect, routingPolicy, selectedProvider.label, sending, vaultReady]);

  const answerAsk = useCallback((response: AgentAskResponse) => {
    const state = useChatStore.getState();
    state.setPendingRequest(state.activeKey, null);
    askResolveRef.current?.(response);
    askResolveRef.current = null;
  }, []);

  const implementPlan = useCallback(() => {
    const state = useChatStore.getState();
    const current = state.slices[state.activeKey]?.plan;
    if (!current || current.locked) return;
    state.lockPlan(state.activeKey, 'implement');
    setPlanMode(false);
    setMode('agent');
    void send(`Implement the approved plan. Follow these steps exactly, verify your work with tools, and finish with the typed patch proposal.\n\nPlan summary: ${current.summary}\n${current.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`);
  }, [send]);

  const refinePlan = useCallback((note: string) => {
    const state = useChatStore.getState();
    const current = state.slices[state.activeKey]?.plan;
    if (!current || current.locked) return;
    state.lockPlan(state.activeKey, 'refine');
    void send(`Refine the plan you proposed. Keep what works, change only what this note requires, and respond with the revised <cursem-plan>.\n\nRefinement note: ${note}`);
  }, [send]);

  const freshPlan = useCallback(() => {
    const state = useChatStore.getState();
    const current = state.slices[state.activeKey]?.plan;
    if (!current || current.locked) return;
    state.lockPlan(state.activeKey, 'fresh');
    const directive = `Implement this plan in a fresh context. Follow the steps exactly, verify your work with tools, and finish with the typed patch proposal.\n\nPlan summary: ${current.summary}\n${current.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`;
    void newThread().then(() => {
      setPlanMode(false);
      setMode('agent');
      void send(directive);
    });
  }, [newThread, send]);

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
        <div className="ai-chat-title"><p className="eyebrow">CODING PARTNER</p><strong>CURSEM</strong><span>{selectedProvider.label}</span></div>
        <div className="ai-header-actions">
          <select className="thread-picker" aria-label="Conversation history" value={threadId || ''} onChange={(event) => void openThread(event.target.value)} disabled={sending}>
            <option value="">New conversation</option>
            {threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
          </select>
          <button className="icon-button compact" onClick={() => void newThread()} aria-label="New conversation" disabled={sending}>+</button>
          <span className={`connection-label ${sending ? 'connected' : vaultReady ? 'ready' : ''}`}>{requestPhase ? `${requestPhase} · ${(requestElapsedMs / 1000).toFixed(1)}s` : vaultReady ? 'Vault ready' : 'Vault unavailable'}</span>
          <button className={`icon-button compact ${settingsOpen ? 'active' : ''}`} onClick={() => setSettingsOpen((open) => !open)} aria-label="Model routing settings" aria-pressed={settingsOpen}><Icon name="settings" size={15} /></button>
          <button className="icon-button compact" onClick={toggleAIChat} aria-label="Close coding partner"><Icon name="close" size={15} /></button>
        </div>
      </header>

      <div className="ai-chat-body">
        <SessionSidebar
          threads={threads}
          activeKey={activeKey}
          runningKey={runningKey}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
          onSelect={(id) => void openThread(id)}
          onNew={() => void newThread()}
          onDelete={deleteThread}
        />

        <div className="ai-chat-main">
          {settingsOpen && (
            <section className="model-routing-settings" aria-label="Model routing settings">
              <div className="routing-grid">
                <label><span>Provider</span><select aria-label="Provider" value={providerId} disabled={!vaultReady} onChange={(event) => changeProvider(event.target.value as ProviderId)}>{vaultProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
                <label><span>Mode</span><select aria-label="Mode" value={mode} onChange={(event) => setMode(event.target.value as 'ask' | 'edit' | 'agent')}><option value="ask">Ask</option><option value="edit" disabled={!activeTabPath}>Edit active file</option><option value="agent">Agent</option></select></label>
                <label><span>Routing</span><select aria-label="Routing" value={routingPolicy} onChange={(event) => setRoutingPolicy(event.target.value as RoutingPolicy)}><option value="manual">Manual</option><option value="cost-first">Low-cost first</option><option value="latency-first">Fastest measured</option><option value="resilient">Resilient fallback</option></select></label>
              </div>
              <label><span>Model</span><select aria-label="Model" value={model} disabled={modelsLoading || !modelOptions.length} onChange={(event) => setModel(event.target.value)}>{modelsLoading ? <option value={model}>loading models…</option> : modelOptions.length ? modelOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>) : <option value={model}>{model || 'no models available'}</option>}</select></label>
              <div className="vault-routing-note">Provider credentials, addresses, and protocol are supplied by the local Vault.</div>
              <label className="host-credential-toggle"><input aria-label="Enable provider-routed CURSEM Tab ghost text" type="checkbox" checked={inlineCompletionEnabled} onChange={(event) => setInlineCompletionEnabled(event.target.checked)} /><span>Enable provider-routed CURSEM Tab ghost text</span></label>
              <details className="memory-manager"><summary>Approved project memory ({memories.length})</summary><div className="memory-entry"><input aria-label="New approved project memory" value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} maxLength={4000} placeholder="A rule or decision to reuse in future threads" /><button className="button ghost" onClick={() => void saveMemory()} disabled={!memoryDraft.trim()}>Save</button></div>{memories.map((memory) => <div className="saved-memory" key={memory.id}><span>{memory.content}</span><button className="text-button" onClick={() => void deleteMemory(memory.id)}>Delete</button></div>)}</details>
              <footer><span className={`dialect-chip ${resolvedDialect}`}>{resolvedDialect} protocol</span><small>{routingDecision}. Every request uses the Vault-owned local relay.</small></footer>
            </section>
          )}

          <div className="context-strip">
            <Icon name="files" size={14} />
            <span>{activeTabPath ? activeTabPath.split('/').pop() : 'No active file'}</span>
            <label><input type="checkbox" checked={includeContext} onChange={(event) => setIncludeContext(event.target.checked)} /> include context</label>
            {contextDisclosure && <details className="context-inspector"><summary>{contextDisclosure.items.length} files · {contextDisclosure.rules.length} rules · {contextDisclosure.totalChars.toLocaleString()} chars</summary><div>{contextDisclosure.items.map((item) => <span key={`${item.path}:${item.reason}`}><strong>{item.path}</strong> — {item.reason} ({item.chars.toLocaleString()} chars)</span>)}{contextDisclosure.rules.map((rule) => <span key={rule}><strong>{rule}</strong> — applied instruction</span>)}</div></details>}
          </div>

          <div className="ai-chat-messages" aria-live="polite">
            {slice.messages.length === 0 && <div className="ai-empty"><div className="ai-orb"><Icon name="spark" size={28} /></div><strong>Build with CURSEM</strong><p>Ask for analysis or switch to Edit mode for a review-gated active-file change. Provider failures are shown without rewriting them.</p><div className="ai-capabilities"><span>Active-file context</span><span>Review-gated edits</span><span>Unified streaming</span><span>Stop propagation</span></div></div>}
            {slice.messages.map((message) => <ChatMessageRow key={message.id} message={message} />)}
            {slice.toolCalls.length > 0 && (
              <div className="chat-tool-stack live">
                {slice.toolCalls.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {slice.pendingRequest && <AskUserCard request={slice.pendingRequest} onAnswer={answerAsk} />}
          {slice.plan && <PlanCard plan={slice.plan} onImplement={implementPlan} onRefine={refinePlan} onFresh={freshPlan} />}

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
            <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (sending && mode === 'agent' && !planMode) steer(); else void send(); } }} placeholder={sending && mode === 'agent' && !planMode ? 'Steer the active Agent run…' : planMode ? 'Describe the goal — CURSEM will investigate read-only and propose a plan' : activeTabPath ? `${mode === 'edit' ? 'Edit' : mode === 'agent' ? 'Agent task for' : 'Ask about'} ${activeTabPath.split('/').pop()} · @file:path @folder:path @symbol:name` : 'Ask CURSEM about the codebase · @file:path @folder:path @symbol:name'} aria-label="Message CURSEM" />
            <div className="composer-footer"><span>{sending && mode === 'agent' && !planMode ? 'Enter interrupts and steers; Stop cancels the run' : 'Enter sends; Shift+Enter adds a line'}</span><div><button className={`button ghost plan-toggle ${planMode ? 'active' : ''}`} onClick={() => setPlanMode((current) => !current)} aria-label="Plan mode" aria-pressed={planMode} disabled={sending}>Plan</button>{slice.messages.length > 0 && <button className="button ghost" onClick={() => void newThread()} disabled={sending}>New thread</button>}{sending ? <>{mode === 'agent' && !planMode && <button className="button primary" onClick={steer} disabled={!input.trim()}>Steer now</button>}<button className="button danger" onClick={stop}><Icon name="stop" size={13} /> Stop</button></> : <button className="button primary send-button" onClick={() => void send()} disabled={!input.trim() || !vaultReady}><Icon name="upload" size={13} /> Send</button>}</div></div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function formatUnknownError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') return String((error as Record<string, unknown>).message);
  try { return JSON.stringify(error); } catch { return 'Unknown provider stream error.'; }
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

function validatePlanResponse(text: string): string | null {
  try {
    return parseAgentPlan(text)
      ? null
      : 'Plan mode requires exactly one valid <cursem-plan> proposal before completion.';
  } catch (error) {
    return error instanceof Error ? error.message : 'Plan mode returned an invalid plan proposal.';
  }
}
