import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToolCard } from '../src/components/chat/ToolCard';
import { PlanCard } from '../src/components/chat/PlanCard';
import { AskUserCard } from '../src/components/chat/AskUserCard';
import type { ToolCallState } from '../src/store/chatStore';

function tool(patch: Partial<ToolCallState>): ToolCallState {
  return { id: 't1', name: 'run_task', args: { executable: 'npm', args: ['test'] }, status: 'completed', startedAt: 1, ...patch };
}

describe('ToolCard', () => {
  it('renders a collapsed verb + summary one-liner and expands to command output', () => {
    const { container } = render(<ToolCard tool={tool({ result: { exitCode: 0, stdout: 'all tests passed', stderr: '', durationMs: 12 } })} />);
    const header = screen.getByRole('button', { name: /Ran npm test/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('all tests passed')).not.toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.getByText('all tests passed')).toBeInTheDocument();
    expect(container.querySelector('.tool-card-exit.ok')).toHaveTextContent('exit code 0');
  });

  it('renders a distinct error state for failed tools', () => {
    const { container } = render(<ToolCard tool={tool({ status: 'failed', error: 'task exploded' })} />);
    expect(container.querySelector('.tool-card.failed')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ran npm test/ }));
    expect(screen.getByText('task exploded')).toBeInTheDocument();
  });

  it('renders a unified diff body for git_diff results', () => {
    render(<ToolCard tool={tool({ name: 'git_diff', args: {}, result: { diff: '@@ -1 +1 @@\n-old\n+new' } })} />);
    fireEvent.click(screen.getByRole('button', { name: /Inspected diff/ }));
    expect(screen.getByText('old')).toBeInTheDocument();
    expect(screen.getByText('new')).toBeInTheDocument();
  });
});

describe('PlanCard', () => {
  const plan = { summary: 'Add a cache layer', steps: ['Create cache', 'Wire invalidation'], locked: false };

  it('renders summary and numbered steps with the action set', () => {
    render(<PlanCard plan={plan} onImplement={() => {}} onRefine={() => {}} onFresh={() => {}} />);
    expect(screen.getByText('Add a cache layer')).toBeInTheDocument();
    expect(screen.getByText('Create cache')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Implement' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refine plan' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Clear context/ })).toBeEnabled();
  });

  it('collects a refinement note before sending', () => {
    const onRefine = vi.fn();
    render(<PlanCard plan={plan} onImplement={() => {}} onRefine={onRefine} onFresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refine plan' }));
    fireEvent.change(screen.getByLabelText('Plan refinement note'), { target: { value: 'skip step 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send refinement' }));
    expect(onRefine).toHaveBeenCalledWith('skip step 2');
  });

  it('renders read-only after the plan was consumed', () => {
    render(<PlanCard plan={{ ...plan, locked: true, decision: 'implement' }} onImplement={() => {}} onRefine={() => {}} onFresh={() => {}} />);
    expect(screen.getByText('Implementation accepted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Implement' })).not.toBeInTheDocument();
  });
});

describe('AskUserCard', () => {
  it('answers select questions with the chosen option', () => {
    const onAnswer = vi.fn();
    render(<AskUserCard request={{ id: 'q1', method: 'select', question: 'Which?', options: ['alpha', 'beta'] }} onAnswer={onAnswer} />);
    expect(screen.getByRole('button', { name: 'Answer' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('beta'));
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(onAnswer).toHaveBeenCalledWith({ value: 'beta' });
  });

  it('answers confirm questions and supports cancellation', () => {
    const onAnswer = vi.fn();
    render(<AskUserCard request={{ id: 'q2', method: 'confirm', question: 'Proceed?' }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onAnswer).toHaveBeenCalledWith({ confirmed: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onAnswer).toHaveBeenCalledWith({ cancelled: true });
  });

  it('answers input questions with free text', () => {
    const onAnswer = vi.fn();
    render(<AskUserCard request={{ id: 'q3', method: 'input', question: 'Name?' }} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'olive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(onAnswer).toHaveBeenCalledWith({ value: 'olive' });
  });
});
