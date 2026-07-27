import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsPanel } from './SkillsPanel';

const skill = {
  id: 'explain',
  name: 'Code Explainer',
  description: 'Explain code clearly',
  instructions: 'Explain it.',
  enabled: true,
  category: 'analysis',
  isActive: false,
};

describe('SkillsPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/skills') {
        return {
          ok: true,
          json: async () => ({ skills: [skill] }),
        } as Response;
      }
      if (url === '/api/skills/explain/activate') {
        return {
          ok: true,
          json: async () => ({ success: true, isActive: true }),
        } as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    }));
  });

  it('names the toggle, exposes pressed state, and applies the returned active state', async () => {
    render(<SkillsPanel isOpen onClose={vi.fn()} />);

    const toggle = await screen.findByRole('button', { name: 'Enable Code Explainer' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Disable Code Explainer' }))
        .toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByText('1 active')).toBeInTheDocument();
  });
});

