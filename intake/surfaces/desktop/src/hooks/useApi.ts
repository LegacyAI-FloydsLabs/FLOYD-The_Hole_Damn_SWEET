/**
 * API hooks for Floyd Web
 */

import { useState, useCallback } from 'react';
import type { Session, Settings } from '@/types';

const API_BASE = '/api';

export function useApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchJson = useCallback(async <T>(url: string, options?: RequestInit): Promise<T> => {
    const response = await fetch(`${API_BASE}${url}`, {
      headers: {
        'Content-Type': 'application/json',
      },
      ...options,
    });
    
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    
    return response.json();
  }, []);

  // Health check
  const checkHealth = useCallback(async () => {
    return fetchJson<{ status: string; hasApiKey: boolean; model: string }>('/health');
  }, [fetchJson]);

  // Settings
  const getSettings = useCallback(async () => {
    return fetchJson<Settings>('/settings');
  }, [fetchJson]);

  const updateSettings = useCallback(async (settings: Partial<{
    provider: 'chatgpt-subscription' | 'anthropic' | 'openai' | 'glm' | 'anthropic-compatible';
    connectorId: string;
    model: string;
    systemPrompt: string;
    maxTokens: number;
  }>) => {
    return fetchJson<{ success: boolean }>('/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    });
  }, [fetchJson]);

  // Sessions
  const getSessions = useCallback(async () => {
    return fetchJson<Session[]>('/sessions');
  }, [fetchJson]);

  const createSession = useCallback(async () => {
    return fetchJson<Session>('/sessions', {
      method: 'POST',
    });
  }, [fetchJson]);

  const getSession = useCallback(async (id: string) => {
    return fetchJson<Session>(`/sessions/${id}`);
  }, [fetchJson]);

  const updateSession = useCallback(async (id: string, data: Partial<Session>) => {
    return fetchJson<Session>(`/sessions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }, [fetchJson]);

  const deleteSession = useCallback(async (id: string) => {
    return fetchJson<{ success: boolean }>(`/sessions/${id}`, {
      method: 'DELETE',
    });
  }, [fetchJson]);

  // Chat (non-streaming)
  const sendMessage = useCallback(async (sessionId: string, message: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchJson<{ success: boolean; response: string; session: { id: string; title: string } }>('/chat', {
        method: 'POST',
        body: JSON.stringify({ sessionId, message }),
      });
      return result;
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  // Chat (streaming with tool support)
  const sendMessageStream = useCallback(async (
    sessionId: string, 
    message: string,
    onText: (text: string) => void,
    onDone: (usage: any, sessionId: string) => void,
    onError: (error: string) => void,
    onToolCall?: (tool: string, args: any, id: string) => void,
    onToolResult?: (tool: string, id: string, result: any, success: boolean) => void,
    attachments?: Array<{
      id: string;
      name: string;
      size: number;
      type: string;
      mimeType: string;
      data: string;
    }>
  ) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${API_BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message, enableTools: true, attachments: attachments || [] }),
      });
      
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');
      
      const decoder = new TextDecoder();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.type === 'text') {
                onText(data.content);
              } else if (data.type === 'tool_call') {
                onToolCall?.(data.tool, data.args, data.id);
              } else if (data.type === 'tool_result') {
                onToolResult?.(data.tool, data.id, data.result, data.success);
              } else if (data.type === 'done') {
                onDone(data.usage, data.sessionId);
              } else if (data.type === 'error') {
                onError(data.error);
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    } catch (err: any) {
      setError(err.message);
      onError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Get available tools
  const getTools = useCallback(async () => {
    return fetchJson<{ tools: any[] }>('/tools');
  }, [fetchJson]);

  // Execute tool directly
  const executeTool = useCallback(async (name: string, args: Record<string, unknown>) => {
    return fetchJson<{ success: boolean; result?: any; error?: string }>('/tools/execute', {
      method: 'POST',
      body: JSON.stringify({ name, args }),
    });
  }, [fetchJson]);

  // Upload files (photos, videos, documents, folders) for chat attachments
  const uploadFiles = useCallback(async (files: File[]) => {
    const formData = new FormData();
    files.forEach(file => {
      formData.append('files', file);
    });

    const response = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    return response.json() as Promise<{
      success: boolean;
      files: Array<{
        id: string;
        name: string;
        size: number;
        type: 'image' | 'video' | 'document' | 'code' | 'data';
        mimeType: string;
        data: string;
      }>;
    }>;
  }, []);

  return {
    loading,
    error,
    checkHealth,
    getSettings,
    updateSettings,
    getSessions,
    createSession,
    getSession,
    updateSession,
    deleteSession,
    sendMessage,
    sendMessageStream,
    getTools,
    executeTool,
    uploadFiles,
  };
}
