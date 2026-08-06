/**
 * Settings Modal Component - Supports Anthropic and OpenAI
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useApi } from '@/hooks/useApi';
import { Loader2, X } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
}

type Provider = 'chatgpt-subscription' | 'anthropic' | 'openai' | 'glm' | 'anthropic-compatible';
type VaultConnector = {
  id: string;
  displayName: string;
  dialect: 'openai' | 'anthropic';
  configured: boolean;
};
type ModelOption = { id: string; name: string };

export function SettingsModal({ isOpen, onClose, onSave }: SettingsModalProps) {
  const api = useApi();
  
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState('claude-sonnet-4-5-20250514');
  const [connectorId, setConnectorId] = useState('');
  const [connectors, setConnectors] = useState<VaultConnector[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, ModelOption[]>>({});
  const [systemPrompt, setSystemPrompt] = useState('');
  const [effectivePrompt, setEffectivePrompt] = useState('');
  const [maxTokens, setMaxTokens] = useState(16384);
  const [showToolCalls, setShowToolCalls] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load settings and the server-provided model catalogs (live via Vault,
  // static fallback) — no model lists are hardcoded in the client.
  useEffect(() => {
    if (isOpen) {
      api.getProviders()
        .then((data) => setProviderModels(data.models || {}))
        .catch(() => {
          // Server unreachable: keep whatever lists were already loaded.
        });
      api.getSettings().then((settings) => {
        setProvider(settings.provider || 'anthropic');
        setModel(settings.model);
        const available = (settings.connectors || [])
          .filter((connector) => connector.dialect === 'anthropic');
        setConnectors(available);
        setConnectorId(
          settings.connectorId
          || available.find((connector) => connector.configured)?.id
          || '',
        );
        setSystemPrompt(settings.systemPrompt || '');
        setEffectivePrompt(settings.effectiveSystemPrompt || '');
        setMaxTokens(settings.maxTokens || 16384);
        setShowToolCalls(settings.showToolCalls ?? false);
      });
    }
  }, [isOpen]);

  // When provider changes, set default model from its server-provided list
  const handleProviderChange = (newProvider: Provider) => {
    setProvider(newProvider);
    const list = providerModels[newProvider] || [];
    if (list.length > 0) setModel(list[0].id);
    if (newProvider === 'anthropic-compatible' && !connectorId) {
      setConnectorId(connectors.find((connector) => connector.configured)?.id || '');
    }
  };

  // Save settings
  const handleSave = async () => {
    setSaving(true);
    
    try {
      await api.updateSettings({
        provider,
        ...(provider === 'anthropic-compatible' ? { connectorId } : {}),
        model,
        systemPrompt,
        maxTokens,
        showToolCalls,
      });
      onSave();
      onClose();
    } catch (err: any) {
      console.error('Failed to save settings:', err);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const models = providerModels[provider] || [];
  // Keep the saved selection visible even if it is not in the fetched list
  // (e.g. renamed upstream before the catalogs finish loading).
  const modelOptions = model && !models.some((m) => m.id === model)
    ? [{ id: model, name: model }, ...models]
    : models;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-slate-800 rounded-lg w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Provider Selection */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              AI Provider
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => handleProviderChange('chatgpt-subscription')}
                className={cn(
                  'p-3 rounded-lg border text-left transition-colors col-span-2',
                  provider === 'chatgpt-subscription'
                    ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-600 hover:border-slate-500'
                )}
              >
                <div className="font-medium">ChatGPT Subscription</div>
                <div className="text-xs text-slate-400">Your ChatGPT plan via OAuth — no API key needed</div>
              </button>
              <button
                onClick={() => handleProviderChange('anthropic')}
                className={cn(
                  'p-3 rounded-lg border text-left transition-colors',
                  provider === 'anthropic'
                    ? 'border-sky-500 bg-sky-500/10 text-sky-300'
                    : 'border-slate-600 hover:border-slate-500'
                )}
              >
                <div className="font-medium">Anthropic</div>
                <div className="text-xs text-slate-400">Official API</div>
              </button>
              <button
                onClick={() => handleProviderChange('anthropic-compatible')}
                className={cn(
                  'p-3 rounded-lg border text-left transition-colors',
                  provider === 'anthropic-compatible'
                    ? 'border-sky-500 bg-sky-500/10 text-sky-300'
                    : 'border-slate-600 hover:border-slate-500'
                )}
              >
                <div className="font-medium">Anthropic-Compatible</div>
                <div className="text-xs text-slate-400">Vault connector</div>
              </button>
              <button
                onClick={() => handleProviderChange('openai')}
                className={cn(
                  'p-3 rounded-lg border text-left transition-colors',
                  provider === 'openai'
                    ? 'border-green-500 bg-green-500/10 text-green-300'
                    : 'border-slate-600 hover:border-slate-500'
                )}
              >
                <div className="font-medium">OpenAI</div>
                <div className="text-xs text-slate-400">GPT Models</div>
              </button>
              <button
                onClick={() => handleProviderChange('glm')}
                className={cn(
                  'p-3 rounded-lg border text-left transition-colors',
                  provider === 'glm'
                    ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                    : 'border-slate-600 hover:border-slate-500'
                )}
              >
                <div className="font-medium">Zai GLM</div>
                <div className="text-xs text-slate-400">Zhipu AI</div>
              </button>
            </div>
          </div>

          <div className="text-sm text-slate-400 bg-slate-700/50 border border-slate-600 rounded px-3 py-2">
            Credentials and provider addresses are managed by the local Vault. Desktop receives only its revocable proxy credential.
          </div>

          {provider === 'anthropic-compatible' && (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Vault Connector
              </label>
              <select
                value={connectorId}
                onChange={(event) => setConnectorId(event.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                <option value="">Select a configured connector</option>
                {connectors.map((connector) => (
                  <option
                    key={connector.id}
                    value={connector.id}
                    disabled={!connector.configured}
                  >
                    {connector.displayName}{connector.configured ? '' : ' (credential required)'}
                  </option>
                ))}
              </select>
              {connectors.length === 0 && (
                <p className="text-xs text-amber-400 mt-1">
                  Add an Anthropic-compatible model connector in Floyd Vault first.
                </p>
              )}
            </div>
          )}

          {/* Model Selection */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          {/* Max Tokens */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Max Tokens
            </label>
            <input
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(parseInt(e.target.value) || 4096)}
              min={256}
              max={128000}
              className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
            <p className="text-xs text-slate-500 mt-1">
              Maximum response length. Higher = longer responses but more cost.
            </p>
          </div>

          {/* Chat display */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Chat
            </label>
            <label className="flex items-start gap-3 bg-slate-700/50 border border-slate-600 rounded px-3 py-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showToolCalls}
                onChange={(e) => setShowToolCalls(e.target.checked)}
                className="mt-0.5 accent-sky-500"
              />
              <span>
                <span className="block text-sm text-slate-200">Show tool calls</span>
                <span className="block text-xs text-slate-400">
                  Display the agent's tool execution cards in chat. Off by default — you see its answers, not its plumbing.
                </span>
              </span>
            </label>
          </div>

          {/* System Prompt */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              System Prompt {systemPrompt ? '(Custom)' : '(Default — capability-aware)'}
            </label>
            <textarea
              value={systemPrompt || effectivePrompt}
              onChange={(e) => setSystemPrompt(e.target.value === effectivePrompt ? '' : e.target.value)}
              placeholder="Custom instructions for Floyd..."
              rows={8}
              className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 resize-none"
            />
            <p className="text-xs text-slate-500 mt-1">
              {systemPrompt
                ? 'Custom prompt overrides the default. Clear the field to restore the built-in capability-aware prompt.'
                : 'This is the built-in prompt the agent uses. It lists every tool the agent can call — files, terminal, code, browser, Browork sub-agents. Edit to override.'}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-slate-700">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-600 rounded hover:bg-slate-500"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || (provider === 'anthropic-compatible' && !connectorId)}
            className="px-4 py-2 bg-sky-600 rounded hover:bg-sky-700 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
