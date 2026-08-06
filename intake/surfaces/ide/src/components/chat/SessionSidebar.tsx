// ─── Session sidebar (Phase 4 S8) ───────────────────────────────────────
//
// Thread list for the coding-partner pane, backed by the durable SQLite
// threads (GET /api/agent/threads), grouped Today / Yesterday / This week /
// Earlier like Cate's AgentSidebar. A live dot marks the thread whose run is
// currently streaming in this pane. Delete is server-side via
// DELETE /api/agent/thread (cascades messages/runs/events); the hidden-ids
// store filter then drops the row locally.

import { Icon } from '@/components/Icon';
import type { AgentThread } from '@/platform';
import { DRAFT_THREAD_KEY } from '@/store/chatStore';

export interface ThreadGroup {
  label: string;
  threads: AgentThread[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Group threads by recency: Today / Yesterday / This week / Earlier. */
export function groupThreads(threads: AgentThread[], now = Date.now()): ThreadGroup[] {
  const today = startOfDay(now);
  const yesterday = today - DAY_MS;
  const week = today - 6 * DAY_MS;
  const groups: ThreadGroup[] = [
    { label: 'Today', threads: [] },
    { label: 'Yesterday', threads: [] },
    { label: 'This week', threads: [] },
    { label: 'Earlier', threads: [] },
  ];
  for (const thread of threads) {
    const stamp = thread.updatedAt || thread.createdAt || 0;
    if (stamp >= today) groups[0].threads.push(thread);
    else if (stamp >= yesterday) groups[1].threads.push(thread);
    else if (stamp >= week) groups[2].threads.push(thread);
    else groups[3].threads.push(thread);
  }
  return groups.filter((group) => group.threads.length > 0);
}

export function SessionSidebar({
  threads,
  activeKey,
  runningKey,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onNew,
  onDelete,
}: {
  threads: AgentThread[];
  activeKey: string;
  runningKey: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  if (collapsed) {
    return (
      <div className="session-sidebar collapsed">
        <button className="icon-button compact" onClick={onToggleCollapsed} aria-label="Show conversations">
          <Icon name="menu" size={14} />
        </button>
        <button className="icon-button compact" onClick={onNew} aria-label="New conversation">
          <Icon name="plus" size={14} />
        </button>
      </div>
    );
  }
  const groups = groupThreads(threads);
  return (
    <div className="session-sidebar" aria-label="Conversations">
      <div className="session-sidebar-header">
        <span>Chats</span>
        <div>
          <button className="icon-button compact" onClick={onNew} aria-label="New conversation">
            <Icon name="plus" size={14} />
          </button>
          <button className="icon-button compact" onClick={onToggleCollapsed} aria-label="Hide conversations">
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      <div className="session-sidebar-list">
        <button
          className={`session-row ${activeKey === DRAFT_THREAD_KEY ? 'active' : ''}`}
          onClick={onNew}
        >
          <span className="session-row-title">New conversation</span>
        </button>
        {groups.length === 0 && <div className="session-empty">No saved conversations yet.</div>}
        {groups.map((group) => (
          <div key={group.label} className="session-group">
            <div className="session-group-label">{group.label}</div>
            {group.threads.map((thread) => (
              <div
                key={thread.id}
                className={`session-row ${activeKey === thread.id ? 'active' : ''}`}
              >
                <button className="session-row-main" onClick={() => onSelect(thread.id)} aria-label={`Open ${thread.title}`}>
                  {runningKey === thread.id && <span className="session-live-dot" aria-label="running" />}
                  <span className="session-row-title">{thread.title || 'Untitled conversation'}</span>
                </button>
                <button
                  className="icon-button compact session-row-delete"
                  onClick={() => onDelete(thread.id)}
                  aria-label={`Delete ${thread.title}`}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
