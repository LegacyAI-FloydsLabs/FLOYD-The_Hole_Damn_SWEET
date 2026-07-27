import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useApi } from '@/hooks/useApi';
import type { Session } from '@/types';

vi.mock('@/hooks/useApi', () => ({
  useApi: vi.fn(),
}));

const existingSession: Session = {
  id: 'existing',
  title: 'Existing chat',
  created: 1,
  updated: 1,
  messages: [{ role: 'user', content: 'Existing private chat' }],
};

const newSession: Session = {
  id: 'new',
  title: 'New Chat',
  created: 2,
  updated: 2,
  messages: [],
};

describe('App New Chat recovery', () => {
  const api = {
    checkHealth: vi.fn(),
    getSettings: vi.fn(),
    getSessions: vi.fn(),
    getSession: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    uploadFiles: vi.fn(),
    sendMessageStream: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.checkHealth.mockResolvedValue({ hasApiKey: true, model: 'gpt-test' });
    api.getSettings.mockResolvedValue({ model: 'gpt-test', hasApiKey: true, apiKeyPreview: null });
    api.getSessions.mockResolvedValue([existingSession]);
    api.getSession.mockResolvedValue(existingSession);
    api.createSession
      .mockRejectedValueOnce(new Error('Load failed'))
      .mockResolvedValueOnce(newSession);
    vi.mocked(useApi).mockReturnValue(api as unknown as ReturnType<typeof useApi>);
  });

  it('shows a real error tone, then opens a blank conversation and restores connection status', async () => {
    render(<App />);

    expect(await screen.findByText('Existing private chat')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Connected to gpt-test')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));

    await waitFor(() => {
      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('data-status-tone', 'error');
      expect(status).toHaveTextContent('Error: Load failed');
    });

    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));

    expect(await screen.findByText('Welcome to Floyd Desktop')).toBeInTheDocument();
    expect(screen.queryByText('Existing private chat')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-status-tone', 'ready');
    expect(screen.getByRole('status')).toHaveTextContent('Connected to gpt-test');
    expect(screen.getByPlaceholderText('Type a message...')).toHaveClass('overflow-x-hidden');
  });
});

