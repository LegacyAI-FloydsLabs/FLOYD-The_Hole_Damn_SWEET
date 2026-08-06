// ─── Plan card (Phase 4 S5) ─────────────────────────────────────────────
//
// Renders a plan-mode <cursem-plan> proposal with Cate's action set:
// Implement (accept and switch the composer into execution), Refine (send a
// follow-up correction while staying in plan mode), and Clear-and-implement
// (start a fresh thread carrying the plan). Lock-after-action: the first
// action consumes the card permanently; plans rehydrated from history always
// render read-only.

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import type { PlanDecision, PlanState } from '@/store/chatStore';

const DECISION_LABELS: Record<PlanDecision, string> = {
  implement: 'Implementation accepted',
  refine: 'Refinement requested',
  fresh: 'Forked into a new thread',
};

export function PlanCard({
  plan,
  onImplement,
  onRefine,
  onFresh,
}: {
  plan: PlanState;
  onImplement: () => void;
  onRefine: (note: string) => void;
  onFresh: () => void;
}) {
  const [refining, setRefining] = useState(false);
  const [note, setNote] = useState('');

  return (
    <section className={`plan-card ${plan.locked ? 'locked' : ''}`} aria-label="Proposed plan">
      <header>
        <Icon name="spark" size={14} />
        <strong>Proposed plan</strong>
        {plan.locked && <span className="plan-card-decision">{plan.decision ? DECISION_LABELS[plan.decision] : 'Consumed'}</span>}
      </header>
      <p className="plan-card-summary">{plan.summary}</p>
      <ol className="plan-card-steps">
        {plan.steps.map((step, index) => <li key={index}>{step}</li>)}
      </ol>
      {!plan.locked && (
        <>
          {refining && (
            <div className="plan-card-refine">
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What should change in this plan?"
                aria-label="Plan refinement note"
              />
            </div>
          )}
          <div className="plan-card-actions">
            <button className="button primary" onClick={onImplement}>Implement</button>
            {refining ? (
              <button className="button ghost" onClick={() => note.trim() && onRefine(note.trim())} disabled={!note.trim()}>Send refinement</button>
            ) : (
              <button className="button ghost" onClick={() => setRefining(true)}>Refine plan</button>
            )}
            <button className="button ghost" onClick={onFresh}>Clear context &amp; implement</button>
          </div>
        </>
      )}
    </section>
  );
}
