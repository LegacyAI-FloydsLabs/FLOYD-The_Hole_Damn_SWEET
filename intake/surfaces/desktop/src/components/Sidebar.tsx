/**
 * Sidebar Component
 */

import { cn } from '@/lib/utils';
import type { Session } from '@/types';
import { Plus, MessageSquare, Trash2, Settings } from 'lucide-react';

interface SidebarProps {
  sessions: Session[];
  currentSessionId?: string;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onOpenSettings: () => void;
  newSessionDisabled?: boolean;
}

export function Sidebar({
  sessions,
  currentSessionId,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onOpenSettings,
  newSessionDisabled,
}: SidebarProps) {
  return (
    <div className="w-64 bg-slate-800 border-r border-slate-700 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-slate-700">
        <button
          onClick={onNewSession}
          disabled={newSessionDisabled}
          className={cn(
            'w-full flex items-center justify-center gap-2 px-4 py-2',
            'bg-sky-600 hover:bg-sky-700 rounded-lg transition-colors',
            'text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        >
          <Plus className="w-4 h-4" />
          New Chat
        </button>
      </div>

      {/* Sessions List */}
      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <div className="text-sm text-slate-500 text-center py-4">
            No conversations yet
          </div>
        ) : (
          <div className="space-y-1">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={cn(
                  'group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer',
                  'hover:bg-slate-700 transition-colors',
                  currentSessionId === session.id && 'bg-slate-700',
                )}
                onClick={() => onSelectSession(session.id)}
              >
                <MessageSquare className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <span className="flex-1 text-sm truncate">{session.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSession(session.id);
                  }}
                  className={cn(
                    'p-1 rounded opacity-0 group-hover:opacity-100',
                    'hover:bg-slate-600 transition-all',
                  )}
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4 text-slate-400 hover:text-red-400" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-slate-700">
        <button
          onClick={onOpenSettings}
          className={cn(
            'w-full flex items-center gap-2 px-3 py-2',
            'hover:bg-slate-700 rounded-lg transition-colors',
            'text-sm text-slate-400',
          )}
        >
          <Settings className="w-4 h-4" />
          Settings
        </button>
      </div>
    </div>
  );
}
