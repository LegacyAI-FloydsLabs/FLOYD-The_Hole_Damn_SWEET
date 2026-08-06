import { beforeEach, describe, expect, it } from 'vitest';
import { DRAFT_THREAD_KEY, useChatStore } from '../src/store/chatStore';
import { groupThreads } from '../src/components/chat/SessionSidebar';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('chat store per-thread slices', () => {
  beforeEach(() => useChatStore.getState().reset());

  it('reduces structured tool events into tool-call cards', () => {
    const store = useChatStore.getState();
    store.applyToolEvent(DRAFT_THREAD_KEY, { type: 'tool_begin', id: 't1', name: 'run_task', args: { executable: 'npm', args: ['test'] } });
    let slice = useChatStore.getState().slices[DRAFT_THREAD_KEY];
    expect(slice.toolCalls).toHaveLength(1);
    expect(slice.toolCalls[0]).toMatchObject({ id: 't1', name: 'run_task', status: 'running' });

    store.applyToolEvent(DRAFT_THREAD_KEY, { type: 'tool_end', id: 't1', name: 'run_task', result: { exitCode: 0 } });
    slice = useChatStore.getState().slices[DRAFT_THREAD_KEY];
    expect(slice.toolCalls[0]).toMatchObject({ status: 'completed', result: { exitCode: 0 } });

    store.applyToolEvent(DRAFT_THREAD_KEY, { type: 'tool_begin', id: 't2', name: 'search', args: { query: 'x' } });
    store.applyToolEvent(DRAFT_THREAD_KEY, { type: 'tool_end', id: 't2', name: 'search', error: 'boom' });
    slice = useChatStore.getState().slices[DRAFT_THREAD_KEY];
    expect(slice.toolCalls[1]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('folds the active run tool cards into the finished assistant message', () => {
    const store = useChatStore.getState();
    store.appendMessage(DRAFT_THREAD_KEY, { id: 'a1', role: 'assistant', content: 'done', pending: true });
    store.applyToolEvent(DRAFT_THREAD_KEY, { type: 'tool_begin', id: 't1', name: 'read_file', args: { path: 'x.ts' } });
    store.applyToolEvent(DRAFT_THREAD_KEY, { type: 'tool_end', id: 't1', name: 'read_file', result: {} });
    store.attachTools(DRAFT_THREAD_KEY, 'a1');
    const slice = useChatStore.getState().slices[DRAFT_THREAD_KEY];
    expect(slice.toolCalls).toHaveLength(0);
    expect(slice.messages[0].tools).toHaveLength(1);
    expect(slice.messages[0].tools?.[0]).toMatchObject({ id: 't1', status: 'completed' });
  });

  it('migrates the draft slice to the durable thread id on first send', () => {
    const store = useChatStore.getState();
    store.appendMessage(DRAFT_THREAD_KEY, { id: 'u1', role: 'user', content: 'hello' });
    store.migrateKey(DRAFT_THREAD_KEY, 'thread-9');
    const state = useChatStore.getState();
    expect(state.activeKey).toBe('thread-9');
    expect(state.slices[DRAFT_THREAD_KEY]).toBeUndefined();
    expect(state.slices['thread-9'].messages).toHaveLength(1);
  });

  it('locks a plan after exactly one action', () => {
    const store = useChatStore.getState();
    store.setPlan(DRAFT_THREAD_KEY, { summary: 'Plan', steps: ['one'], locked: false });
    store.lockPlan(DRAFT_THREAD_KEY, 'implement');
    const plan = useChatStore.getState().slices[DRAFT_THREAD_KEY].plan;
    expect(plan).toMatchObject({ locked: true, decision: 'implement' });
  });

  it('tracks the running slice for the sidebar live indicator', () => {
    const store = useChatStore.getState();
    store.setRunning('thread-1', true);
    expect(useChatStore.getState().runningKey).toBe('thread-1');
    store.setRunning('thread-1', false);
    expect(useChatStore.getState().runningKey).toBeNull();
  });
});

describe('session sidebar grouping', () => {
  it('groups threads into Today / Yesterday / This week / Earlier', () => {
    const now = new Date('2026-08-06T15:00:00-04:00').getTime();
    const today = new Date('2026-08-06T15:00:00-04:00'); today.setHours(0, 0, 0, 0);
    const threads = [
      { id: 'a', title: 'today', createdAt: now, updatedAt: now },
      { id: 'b', title: 'yesterday', createdAt: now, updatedAt: today.getTime() - DAY_MS },
      { id: 'c', title: 'this week', createdAt: now, updatedAt: today.getTime() - 3 * DAY_MS },
      { id: 'd', title: 'earlier', createdAt: now, updatedAt: today.getTime() - 30 * DAY_MS },
    ];
    const groups = groupThreads(threads, now);
    expect(groups.map((group) => [group.label, group.threads.map((thread) => thread.id)])).toEqual([
      ['Today', ['a']],
      ['Yesterday', ['b']],
      ['This week', ['c']],
      ['Earlier', ['d']],
    ]);
  });

  it('omits empty groups', () => {
    const now = Date.now();
    expect(groupThreads([{ id: 'a', title: 't', createdAt: now, updatedAt: now }], now).map((group) => group.label)).toEqual(['Today']);
  });
});
