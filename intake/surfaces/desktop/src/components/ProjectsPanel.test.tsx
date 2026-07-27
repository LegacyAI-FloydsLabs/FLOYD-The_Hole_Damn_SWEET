import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsPanel } from './ProjectsPanel';

describe('ProjectsPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ projects: [], activeId: null }),
    }));
  });

  it('labels the optional project description consistently', async () => {
    render(<ProjectsPanel isOpen onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create New Project' }));

    expect(screen.getByPlaceholderText('Description (optional)')).toBeInTheDocument();
  });
});

