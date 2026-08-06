export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: 'image' | 'video' | 'document' | 'code' | 'data';
  mimeType: string;
  data: string; // base64
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
  attachments?: Attachment[];
  /** Set when the Vault served this reply through its GLM fallback: the
   *  provider that failed and the model that actually answered. */
  fallback?: { provider: string; model: string | null } | null;
}

export interface Session {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: Message[];
  messageCount?: number;
}

export interface Settings {
  provider?: 'chatgpt-subscription' | 'anthropic' | 'openai' | 'glm' | 'anthropic-compatible';
  model: string;
  connectorId?: string;
  connectors?: Array<{
    id: string;
    displayName: string;
    dialect: 'openai' | 'anthropic';
    configured: boolean;
  }>;
  hasApiKey: boolean;
  apiKeyPreview: string | null;
  systemPrompt?: string;
  effectiveSystemPrompt?: string;
  maxTokens?: number;
  /** Show tool execution cards in chat. Off by default: the user sees the
   *  agent's prose summary, not its plumbing. */
  showToolCalls?: boolean;
  baseURL?: string;
}
