/**
 * Settings Modal Component - Supports Anthropic and OpenAI
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useApi } from '@/hooks/useApi';
import { X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
}

type Provider = 'chatgpt-subscription' | 'anthropic' | 'openai' | 'glm' | 'anthropic-compatible';

const PROVIDER_MODELS: Record<Provider, Array<{ id: string; name: string }>> = {
  'chatgpt-subscription': [
    { id: 'gpt-5.5', name: 'GPT-5.5 (Most Capable)' },
    { id: 'gpt-5.4', name: 'GPT-5.4 (Balanced)' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini (Fast)' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex (Coding)' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-5-20250514', name: 'Claude 4.5 Sonnet (Recommended)' },
    { id: 'claude-opus-4-5-20250514', name: 'Claude 4.5 Opus (Most Capable)' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude 4 Sonnet' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku (Fast)' },
  ],
  'anthropic-compatible': [
    { id: 'glm-4.7', name: 'GLM-4.7 (Standard, Complex Tasks)' },
    { id: 'glm-4.5-air', name: 'GLM-4.5 Air (Lightweight, Faster)' },
    { id: 'glm-4-plus', name: 'GLM-4 Plus (Most Capable)' },
    { id: 'glm-4-0520', name: 'GLM-4-0520 (Recommended)' },
    { id: 'glm-4', name: 'GLM-4 (Standard)' },
    { id: 'glm-4-air', name: 'GLM-4 Air (Fast)' },
    { id: 'glm-4-airx', name: 'GLM-4 AirX (Faster)' },
    { id: 'glm-4-long', name: 'GLM-4 Long (128K Context)' },
    { id: 'glm-4-flash', name: 'GLM-4 Flash (Cheapest)' },
    { id: 'claude-sonnet-4-5-20250514', name: 'Claude 4.5 Sonnet' },
    { id: 'claude-opus-4-5-20250514', name: 'Claude 4.5 Opus' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude 4 Sonnet' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
    { id: 'custom-model', name: 'Custom Model (specify in settings)' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o (Recommended)' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Fast & Cheap)' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'gpt-4', name: 'GPT-4' },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo (Cheapest)' },
  ],
  glm: [
    { id: 'glm-4-plus', name: 'GLM-4 Plus (Most Capable)' },
    { id: 'glm-4-0520', name: 'GLM-4-0520 (Recommended)' },
    { id: 'glm-4', name: 'GLM-4 (Standard)' },
    { id: 'glm-4-air', name: 'GLM-4 Air (Fast)' },
    { id: 'glm-4-airx', name: 'GLM-4 AirX (Faster)' },
    { id: 'glm-4-long', name: 'GLM-4 Long (128K Context)' },
    { id: 'glm-4-flash', name: 'GLM-4 Flash (Cheapest)' },
  ],
};

export function SettingsModal({ isOpen, onClose, onSave }: SettingsModalProps) {
  const api = useApi();
  
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-5-20250514');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [effectivePrompt, setEffectivePrompt] = useState('');
  const [maxTokens, setMaxTokens] = useState(16384);
  const [baseURL, setBaseURL] = useState('');
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [keyPreview, setKeyPreview] = useState<string | null>(null);
  
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Load settings
  useEffect(() => {
    if (isOpen) {
      api.getSettings().then((settings) => {
        setProvider(settings.provider || 'anthropic');
        setModel(settings.model);
        setHasExistingKey(settings.hasApiKey);
        setKeyPreview(settings.apiKeyPreview);
        setSystemPrompt(settings.systemPrompt || '');
        setEffectivePrompt(settings.effectiveSystemPrompt || '');
        setMaxTokens(settings.maxTokens || 16384);
        setBaseURL(settings.baseURL || '');
        setApiKey('');
        setTestResult(null);
      });
    }
  }, [isOpen]);

  // When provider changes, set default model
  const handleProviderChange = (newProvider: Provider) => {
    setProvider(newProvider);
    setModel(PROVIDER_MODELS[newProvider][0].id);
    setApiKey('');
    setTestResult(null);
    setHasExistingKey(false);
    setKeyPreview(null);
  };

  // Test API key
  const handleTest = async () => {
    if (!apiKey) {
      setTestResult({ success: false, message: 'Enter an API key to test' });
      return;
    }
    
    setTesting(true);
    setTestResult(null);
    
    try {
      const result = await api.testApiKey(apiKey, provider);
      setTestResult({ 
        success: result.success, 
        message: result.success ? `Valid! ${result.message}` : (result.error || 'Invalid key')
      });
    } catch (err: any) {
      setTestResult({ success: false, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  // Save settings
  const handleSave = async () => {
    setSaving(true);
    
    try {
      await api.updateSettings({
        provider,
        ...(apiKey ? { apiKey } : {}),
        model,
        systemPrompt,
        maxTokens,
        ...(provider === 'anthropic-compatible' && baseURL ? { baseURL } : {}),
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

  const models = PROVIDER_MODELS[provider];

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
                <div className="text-xs text-slate-400">Custom Endpoint</div>
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

          {/* API Key (not needed for ChatGPT subscription) */}
          {provider === 'chatgpt-subscription' ? (
            <div className="text-sm text-slate-400 bg-slate-700/50 border border-slate-600 rounded px-3 py-2">
              Uses your ChatGPT sign-in (OAuth tokens from <code className="text-slate-300">~/.codex/auth.json</code>).
              If chat fails with an auth error, run <code className="text-slate-300">codex login</code> in a terminal and retry.
            </div>
          ) : (
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              {provider === 'anthropic' || provider === 'anthropic-compatible' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : 'GLM'} API Key
            </label>
            {hasExistingKey && keyPreview && (
              <div className="text-xs text-slate-500 mb-2">
                Current: {keyPreview}
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setTestResult(null);
                }}
                placeholder={hasExistingKey ? 'Enter new key to change' : `${provider === 'anthropic' || provider === 'anthropic-compatible' ? 'sk-ant-...' : provider === 'openai' ? 'sk-...' : 'xxxxxxxx.xxxxxxxx'}`}
                className="flex-1 bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
              <button
                onClick={handleTest}
                disabled={testing || !apiKey}
                className="px-4 py-2 bg-slate-600 rounded text-sm hover:bg-slate-500 disabled:opacity-50 flex items-center gap-2"
              >
                {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Test'}
              </button>
            </div>
            {testResult && (
              <div className={cn(
                'mt-2 text-sm flex items-center gap-2',
                testResult.success ? 'text-green-400' : 'text-red-400'
              )}>
                {testResult.success ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                {testResult.message}
              </div>
            )}
          </div>
          )}

          {/* Base URL - only for anthropic-compatible */}
          {provider === 'anthropic-compatible' && (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                API Endpoint URL
              </label>
              <input
                type="text"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder="https://api.example.com/v1/messages"
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
              <p className="text-xs text-slate-500 mt-1">
                Enter the base URL of your Anthropic-compatible API endpoint.
              </p>
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
              {models.map((m) => (
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
            disabled={saving}
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
