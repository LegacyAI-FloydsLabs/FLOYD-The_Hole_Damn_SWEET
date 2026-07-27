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
  hasApiKey: boolean;
  apiKeyPreview: string | null;
  systemPrompt?: string;
  effectiveSystemPrompt?: string;
  maxTokens?: number;
  baseURL?: string;
}
