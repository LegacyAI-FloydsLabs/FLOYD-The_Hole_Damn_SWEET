// ─── Chat store (Phase 4 S2) ────────────────────────────────────────────
//
// Per-thread chat state extracted from AIChatPane's useState into a single
// zustand store, mirroring Cate's agentStore shape. Deliberately NOT
// persisted: the per-workspace SQLite agent store (threads/messages/runs/
// run_events) is the durability layer — this store holds live render state
// (streaming text, tool-call cards, pending ask requests, plan cards) and is
// rehydrated from SQLite whenever a thread is opened.

import { create } from 'zustand';
import type { AgentAskRequest, AgentPlan, AgentToolEvent, AgentToolName } from '@/agent';
import type { AgentThread } from '@/platform';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
  fallback?: { requestedProvider: string; model: string };
  /** Tool cards recorded while this assistant message streamed. */
  tools?: ToolCallState[];
}

export type ToolCallStatus = 'running' | 'completed' | 'failed';

export interface ToolCallState {
  id: string;
  name: AgentToolName;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
  note?: string;
  startedAt: number;
  endedAt?: number;
}

export type ChatStreamingPhase = 'preparing' | 'connecting' | 'streaming' | null;

export type PlanDecision = 'implement' | 'refine' | 'fresh';

export interface PlanState extends AgentPlan {
  /** Lock-after-action: an accepted/refined/forked plan can never be acted on twice. */
  locked: boolean;
  decision?: PlanDecision;
}

export interface ThreadChatSlice {
  messages: ChatMessage[];
  running: boolean;
  streamingPhase: ChatStreamingPhase;
  usage: Record<string, number> | null;
  /** Tool cards of the run currently streaming; folded into the assistant message on completion. */
  toolCalls: ToolCallState[];
  /** A blocking <cursem-ask> question awaiting a UI answer. */
  pendingRequest: AgentAskRequest | null;
  plan: PlanState | null;
}

/** Store key for the not-yet-persisted conversation (no SQLite thread yet). */
export const DRAFT_THREAD_KEY = '__draft__';

function emptySlice(): ThreadChatSlice {
  return { messages: [], running: false, streamingPhase: null, usage: null, toolCalls: [], pendingRequest: null, plan: null };
}

interface ChatState {
  slices: Record<string, ThreadChatSlice>;
  /** Active slice key: a thread id, or DRAFT_THREAD_KEY for a new conversation. */
  activeKey: string;
  /** Slice key with a live run — drives the sidebar's running indicator. */
  runningKey: string | null;
  threads: AgentThread[];
  /** Client-side thread deletion: no backend delete endpoint exists yet. */
  hiddenThreadIds: string[];

  setActiveKey: (key: string) => void;
  setThreads: (threads: AgentThread[]) => void;
  upsertThread: (thread: AgentThread) => void;
  hideThread: (id: string) => void;
  appendMessage: (key: string, message: ChatMessage) => void;
  updateMessage: (key: string, id: string, patch: Partial<ChatMessage>) => void;
  appendMessageText: (key: string, id: string, text: string) => void;
  /** Fold the active run's tool cards into the finished assistant message. */
  attachTools: (key: string, messageId: string) => void;
  setRunning: (key: string, running: boolean) => void;
  setPhase: (key: string, phase: ChatStreamingPhase) => void;
  setUsage: (key: string, usage: Record<string, number> | null) => void;
  applyToolEvent: (key: string, event: AgentToolEvent) => void;
  setPendingRequest: (key: string, request: AgentAskRequest | null) => void;
  setPlan: (key: string, plan: PlanState | null) => void;
  lockPlan: (key: string, decision: PlanDecision) => void;
  /** Re-key the draft slice once the first send creates a durable thread. */
  migrateKey: (from: string, to: string) => void;
  /** Hydrate a slice from the durable transcript when a thread is opened. */
  loadThread: (key: string, messages: ChatMessage[], plan?: PlanState | null) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>()((set) => {
  const patchSlice = (key: string, patch: (slice: ThreadChatSlice) => Partial<ThreadChatSlice>) =>
    set((state) => ({ slices: { ...state.slices, [key]: { ...(state.slices[key] || emptySlice()), ...patch(state.slices[key] || emptySlice()) } } }));

  return {
    slices: { [DRAFT_THREAD_KEY]: emptySlice() },
    activeKey: DRAFT_THREAD_KEY,
    runningKey: null,
    threads: [],
    hiddenThreadIds: [],

    setActiveKey: (key) => set({ activeKey: key }),
    setThreads: (threads) => set({ threads }),
    upsertThread: (thread) => set((state) => ({
      threads: [thread, ...state.threads.filter((entry) => entry.id !== thread.id)],
    })),
    hideThread: (id) => set((state) => ({
      hiddenThreadIds: state.hiddenThreadIds.includes(id) ? state.hiddenThreadIds : [...state.hiddenThreadIds, id],
      threads: state.threads.filter((thread) => thread.id !== id),
    })),
    appendMessage: (key, message) => patchSlice(key, (slice) => ({ messages: [...slice.messages, message] })),
    updateMessage: (key, id, patch) => patchSlice(key, (slice) => ({
      messages: slice.messages.map((message) => (message.id === id ? { ...message, ...patch } : message)),
    })),
    appendMessageText: (key, id, text) => patchSlice(key, (slice) => ({
      messages: slice.messages.map((message) => (message.id === id ? { ...message, content: message.content + text } : message)),
    })),
    attachTools: (key, messageId) => patchSlice(key, (slice) => {
      if (!slice.toolCalls.length) return {};
      return {
        toolCalls: [],
        messages: slice.messages.map((message) => (message.id === messageId ? { ...message, tools: [...slice.toolCalls] } : message)),
      };
    }),
    setRunning: (key, running) => {
      patchSlice(key, () => ({ running }));
      set((state) => ({ runningKey: running ? key : state.runningKey === key ? null : state.runningKey }));
    },
    setPhase: (key, phase) => patchSlice(key, () => ({ streamingPhase: phase })),
    setUsage: (key, usage) => patchSlice(key, () => ({ usage })),
    applyToolEvent: (key, event) => patchSlice(key, (slice) => {
      if (event.type === 'tool_begin') {
        const toolCall: ToolCallState = { id: event.id, name: event.name, args: event.args, status: 'running', startedAt: Date.now() };
        return { toolCalls: [...slice.toolCalls.filter((entry) => entry.id !== event.id), toolCall] };
      }
      if (event.type === 'tool_progress') {
        return { toolCalls: slice.toolCalls.map((entry) => (entry.id === event.id ? { ...entry, note: event.note } : entry)) };
      }
      return {
        toolCalls: slice.toolCalls.map((entry) => (entry.id === event.id
          ? { ...entry, status: event.error ? 'failed' : 'completed', result: event.result, error: event.error, endedAt: Date.now() }
          : entry)),
      };
    }),
    setPendingRequest: (key, request) => patchSlice(key, () => ({ pendingRequest: request })),
    setPlan: (key, plan) => patchSlice(key, () => ({ plan })),
    lockPlan: (key, decision) => patchSlice(key, (slice) => ({
      plan: slice.plan ? { ...slice.plan, locked: true, decision } : slice.plan,
    })),
    migrateKey: (from, to) => set((state) => {
      if (from === to || !state.slices[from]) return {};
      const slices = { ...state.slices, [to]: state.slices[from] };
      delete slices[from];
      return {
        slices,
        activeKey: state.activeKey === from ? to : state.activeKey,
        runningKey: state.runningKey === from ? to : state.runningKey,
      };
    }),
    loadThread: (key, messages, plan = null) =>
      set((state) => ({ slices: { ...state.slices, [key]: { ...emptySlice(), messages, plan } } })),
    reset: () => set({
      slices: { [DRAFT_THREAD_KEY]: emptySlice() },
      activeKey: DRAFT_THREAD_KEY,
      runningKey: null,
      threads: [],
      hiddenThreadIds: [],
    }),
  };
});

/** Select the active slice, creating an empty view for unseen keys. */
export function selectActiveSlice(state: ChatState): ThreadChatSlice {
  return state.slices[state.activeKey] || emptySlice();
}
