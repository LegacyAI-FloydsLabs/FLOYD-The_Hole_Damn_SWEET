// ─── Chat message row (Phase 4 S3) ──────────────────────────────────────
//
// One transcript row: user bubble or assistant text plus the tool-call cards
// recorded while that assistant message streamed. Protocol envelopes
// (<cursem-patch>, <cursem-tool>, <cursem-plan>, <cursem-ask>) never render
// raw — they are summarized or rendered as dedicated cards.

import { PROVIDERS, type ProviderId } from '@/model-routing';
import type { ChatMessage } from '@/store/chatStore';
import { ToolCard } from './ToolCard';

function providerLabelFor(providerId: string): string {
  return providerId in PROVIDERS ? PROVIDERS[providerId as ProviderId].label : providerId;
}

/** Replace protocol envelopes with readable placeholders for transcript display. */
export function displayMessage(content: string): string {
  return content
    .replace(/<cursem-patch>[\s\S]*?<\/cursem-patch>/gi, '\n[Typed patch ready for review]\n')
    .replace(/<cursem-plan>[\s\S]*?<\/cursem-plan>/gi, '\n[Plan proposed]\n')
    .replace(/<cursem-ask>[\s\S]*?<\/cursem-ask>/gi, '\n[Question asked]\n')
    .replace(/<cursem-tool>([\s\S]*?)<\/cursem-tool>/gi, (_match, raw: string) => {
      try { const tool = JSON.parse(raw) as { name?: string }; return `\n[Tool requested: ${tool.name || 'unknown'}]\n`; }
      catch { return '\n[Tool request]\n'; }
    })
    .trim();
}

export function ChatMessageRow({ message }: { message: ChatMessage }) {
  if (message.pending && !message.content && !message.fallback && !(message.tools && message.tools.length)) return null;
  return (
    <article className={`chat-message ${message.role} ${message.pending ? 'pending' : ''}`}>
      <header>
        {message.role === 'user' ? 'You' : 'CURSEM'}
        {message.pending && <span>streaming</span>}
      </header>
      {message.fallback && (
        <div className="fallback-notice">
          {providerLabelFor(message.fallback.requestedProvider)} failed — answered by GLM ({message.fallback.model})
        </div>
      )}
      {message.tools && message.tools.length > 0 && (
        <div className="chat-tool-stack">
          {message.tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
        </div>
      )}
      {message.content && <div>{displayMessage(message.content)}</div>}
    </article>
  );
}
