/**
 * ChatGPT Subscription (OAuth) client.
 *
 * Uses the operator's ChatGPT monthly subscription exclusively through the
 * local Vault. Supports streaming text, vision, and function tool calling.
 *
 * Credential handling:
 * This client never reads, refreshes, or stores OAuth credentials. It receives
 * only Desktop's fv_ capability and the loopback Vault address.
 */

export const CHATGPT_MODELS = [
  { id: 'gpt-5.5', name: 'GPT-5.5 (Most Capable)' },
  { id: 'gpt-5.4', name: 'GPT-5.4 (Balanced)' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini (Fast)' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex (Coding)' },
];

export interface ChatGPTToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One item of Responses-API input. */
export type ResponseInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: Array<Record<string, unknown>> }
  | { type: 'function_call'; name: string; arguments: string; call_id: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface StreamCallbacks {
  onText?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, callId: string) => void;
  onError?: (message: string) => void;
}

export interface TurnResult {
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; callId: string }>;
  /** Raw output items to append to the conversation for the next turn. */
  outputItems: ResponseInputItem[];
}

export class ChatGPTSubscriptionClient {
  private readonly vaultUrl = String(process.env.FLOYD_VAULT_PROXY_URL || '').replace(/\/+$/, '');
  private readonly vaultToken = String(process.env.FLOYD_VAULT_PROXY_TOKEN || '');

  async isConfigured(): Promise<boolean> {
    try {
      if (!/^fv_/.test(this.vaultToken) || !this.vaultUrl) return false;
      const res = await fetch(`${this.vaultUrl}/status`, {
        headers: { authorization: `Bearer ${this.vaultToken}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      const status = await res.json() as { subscriptionConfigured?: boolean };
      return status.subscriptionConfigured === true;
    } catch {
      return false;
    }
  }

  /** Non-secret status for health/settings endpoints. */
  async status(): Promise<{ configured: boolean; route: string }> {
    return { configured: await this.isConfigured(), route: 'floyd-vault' };
  }

  /**
   * Run one model turn (streaming). Emits text deltas and collected tool calls
   * through callbacks; resolves with the full turn result.
   */
  async runTurn(options: {
    model: string;
    instructions: string;
    input: ResponseInputItem[];
    tools?: ChatGPTToolDef[];
    callbacks?: StreamCallbacks;
  }): Promise<TurnResult> {
    const { model, instructions, input, tools, callbacks } = options;
    if (!await this.isConfigured()) throw new Error('Desktop Vault capability is unavailable');

    const body: Record<string, unknown> = {
      model,
      instructions,
      input,
      stream: true,
      store: false,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.vaultToken}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      'User-Agent': 'floyd-desktop/0.1 (codex_cli_rs compatible)',
    };
    const res = await fetch(`${this.vaultUrl}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`ChatGPT backend HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const result: TurnResult = { text: '', toolCalls: [], outputItems: [] };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev: any;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        switch (ev.type) {
          case 'response.output_text.delta':
            result.text += ev.delta;
            callbacks?.onText?.(ev.delta);
            break;
          case 'response.output_item.done': {
            const item = ev.item;
            if (item?.type === 'function_call') {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(item.arguments || '{}');
              } catch {
                /* leave empty */
              }
              const callId = item.call_id || item.id;
              result.toolCalls.push({ name: item.name, args, callId });
              result.outputItems.push({
                type: 'function_call',
                name: item.name,
                arguments: item.arguments || '{}',
                call_id: callId,
              });
              callbacks?.onToolCall?.(item.name, args, callId);
            } else if (item?.type === 'message') {
              result.outputItems.push({
                type: 'message',
                role: item.role || 'assistant',
                content: item.content || [{ type: 'output_text', text: result.text }],
              });
            }
            break;
          }
          case 'response.failed':
          case 'error': {
            const msg = ev.response?.error?.message || ev.error?.message || ev.message || 'ChatGPT backend error';
            callbacks?.onError?.(msg);
            throw new Error(msg);
          }
        }
      }
    }

    return result;
  }
}

/** Build user message content parts, supporting optional base64 images. */
export function userMessage(text: string, images?: Array<{ mediaType: string; base64: string }>): ResponseInputItem {
  const content: Array<Record<string, unknown>> = [];
  if (images) {
    for (const img of images) {
      content.push({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.base64}` });
    }
  }
  content.push({ type: 'input_text', text });
  return { type: 'message', role: 'user', content };
}

/** Wrap a prior assistant text reply for conversation history. */
export function assistantMessage(text: string): ResponseInputItem {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

/** Wrap a tool result for the next turn. */
export function toolResult(callId: string, output: unknown): ResponseInputItem {
  return {
    type: 'function_call_output',
    call_id: callId,
    output: typeof output === 'string' ? output : JSON.stringify(output),
  };
}
