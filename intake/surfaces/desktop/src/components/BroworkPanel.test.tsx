import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BroworkPanel } from './BroworkPanel';

describe('BroworkPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tasks: [] }),
    }));
  });

  it('prevents an empty description from rendering a horizontal scrollbar', async () => {
    render(<BroworkPanel isOpen onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create New Agent Task' }));

    expect(
      screen.getByPlaceholderText('Detailed description of what the agent should do...'),
    ).toHaveClass('overflow-x-hidden');
  });
});

