import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('@/hooks/useApi', () => ({
  useApi: () => api,
}));

describe('SettingsModal Vault connector selection', () => {
  beforeEach(() => {
    api.getProviders.mockReset();
    api.getSettings.mockReset();
    api.updateSettings.mockReset();
    api.getProviders.mockResolvedValue({
      providers: [],
      models: {
        anthropic: [{ id: 'claude-sonnet-4-5-20250514', name: 'Claude 4.5 Sonnet' }],
        'anthropic-compatible': [{ id: 'glm-4.7', name: 'GLM-4.7' }],
      },
      modelSources: { anthropic: 'live', 'anthropic-compatible': 'fallback' },
      connectors: [],
      chatgpt: { configured: false },
    });
    api.getSettings.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250514',
      hasApiKey: true,
      apiKeyPreview: 'Managed by Vault',
      maxTokens: 16384,
      effectiveSystemPrompt: 'Default prompt',
      connectors: [{
        id: 'private-anthropic',
        displayName: 'Private Anthropic',
        dialect: 'anthropic',
        configured: true,
      }],
    });
    api.updateSettings.mockResolvedValue({ success: true });
  });

  it('submits the configured Vault connector ID without a key or provider address', async () => {
    render(<SettingsModal isOpen onClose={vi.fn()} onSave={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Anthropic-Compatible/ }));
    const connectorLabel = await screen.findByText('Vault Connector');
    const connectorSelect = connectorLabel.parentElement?.querySelector('select');
    expect(connectorSelect).not.toBeNull();
    fireEvent.change(connectorSelect!, { target: { value: 'private-anthropic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledOnce());
    const submitted = api.updateSettings.mock.calls[0][0];
    expect(submitted).toMatchObject({
      provider: 'anthropic-compatible',
      connectorId: 'private-anthropic',
    });
    expect(submitted).not.toHaveProperty('apiKey');
    expect(submitted).not.toHaveProperty('baseURL');
  });
});
