// ─── Ask-user card (Phase 4 S6) ─────────────────────────────────────────
//
// Renders a blocking <cursem-ask> question inline in the chat flow. The
// agent runner is in-process, so no stdin sub-protocol is needed: the card
// resolves the promise the runner is awaiting, through the onAnswer callback
// wired to chatStore.pendingRequest. Cancel answers {cancelled:true} so the
// model can decide how to proceed instead of crashing the run.

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import type { AgentAskRequest, AgentAskResponse } from '@/agent';

export function AskUserCard({
  request,
  onAnswer,
}: {
  request: AgentAskRequest;
  onAnswer: (response: AgentAskResponse) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState('');

  return (
    <section className="ask-user-card" aria-label="CURSEM asks">
      <header>
        <Icon name="info" size={14} />
        <strong>CURSEM asks</strong>
        <span className="ask-user-method">{request.method}</span>
      </header>
      <p className="ask-user-question">{request.question}</p>
      {request.detail && <p className="ask-user-detail">{request.detail}</p>}

      {request.method === 'select' && (
        <div className="ask-user-options" role="radiogroup" aria-label="Choices">
          {(request.options || []).map((option) => (
            <label key={option} className={selected === option ? 'selected' : ''}>
              <input
                type="radio"
                name={`ask-${request.id}`}
                checked={selected === option}
                onChange={() => setSelected(option)}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      )}
      {request.method === 'input' && (
        <input
          className="ask-user-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Type your answer…"
          aria-label="Your answer"
        />
      )}

      <div className="ask-user-actions">
        {request.method === 'confirm' && (
          <>
            <button className="button primary" onClick={() => onAnswer({ confirmed: true })}>Confirm</button>
            <button className="button ghost" onClick={() => onAnswer({ confirmed: false })}>Decline</button>
          </>
        )}
        {request.method === 'select' && (
          <button className="button primary" onClick={() => selected && onAnswer({ value: selected })} disabled={!selected}>Answer</button>
        )}
        {request.method === 'input' && (
          <button className="button primary" onClick={() => text.trim() && onAnswer({ value: text.trim() })} disabled={!text.trim()}>Answer</button>
        )}
        <button className="button ghost" onClick={() => onAnswer({ cancelled: true })}>Cancel</button>
      </div>
    </section>
  );
}
