/**
 * Floyd Web - Backend Server
 * 
 * Express server with Anthropic SDK integration.
 * Handles chat, streaming, sessions, and settings.
 */

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { ToolExecutor } from './tool-executor.js';
import { BUILTIN_TOOLS, MCPClient } from './mcp-client.js';
import { GATEWAY_TOOLS, isGatewayTool, executeGatewayTool, gatewayAvailable } from './mcp-gateway.js';
import { chronoAfterToolCall } from './chrono-hook.js';
import { CHRONO_TOOLS, isChronoTool, executeChronoTool, chronoToolsAvailable } from './chrono-tools.js';
import { SkillsManager, Skill } from './skills-manager.js';
import { ProjectsManager, Project } from './projects-manager.js';
import { BroworkManager, AgentTask, Provider as BroworkProvider } from './browork-manager.js';
import { WebSocketMCPServer } from './ws-mcp-server.js';
import {
  ChatGPTSubscriptionClient,
  userMessage as chatgptUserMessage,
  toolResult as chatgptToolResult,
  type ResponseInputItem,
} from './chatgpt-subscription.js';
import {
  STATIC_PROVIDER_MODELS,
  resolveBootProviderModel,
  resolveDesktopProviderModels,
  resolveGlmSeedModel,
} from './live-models.js';
import { captureVaultFallback, type VaultFallbackNotice } from './vault-fallback.js';
import {
  DesktopExperienceCoordinator,
  defaultCoreBaseUrl,
  desktopProviderForRoute,
  readGatewayToken,
  type DesktopExperienceState,
} from './floyd-core-experience.js';
import { buildDefaultSystemPrompt } from './prompts/default-system-prompt.js';
import { buildNeverSilentCompletion, TRUNCATION_NOTE } from './completion-guard.js';
import {
  isDesktopProviderReady,
  listVaultModelConnectors,
  readDesktopVaultStatus,
  vaultConnectorBaseURL,
  type DesktopModelConnector,
} from './vault-model-connectors.js';

// Load .env.local
config({ path: '.env.local' });

// ---- Admitted-surface identity -------------------------------------------
// Floyd Core verifies each surface by probing /api/health for an identity
// block: { surface_id, source_root, source_commit }. The commit is read from
// this copy's git HEAD once at startup so the surface honestly reports what
// code it is actually running.
import { execSync } from 'child_process';
const SURFACE_IDENTITY = (() => {
  const surfaceId = process.env.FLOYD_SURFACE_ID || 'desktop';
  let sourceRoot = process.cwd();
  let sourceCommit = process.env.FLOYD_SOURCE_COMMIT || '';
  try {
    sourceRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    sourceCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // Non-git deployment: fall back to env/cwd values.
  }
  return { surface_id: surfaceId, source_root: sourceRoot, source_commit: sourceCommit };
})();

// Initialize WebSocket MCP server for Chrome extension
let wsMcpServer: WebSocketMCPServer | null = null;

// Initialize tool executor. Allowed roots cover the app itself, the operator
// home and temp space. Extend explicitly with FLOYD_TOOL_PATHS; clean installs
// never assume a development volume exists.
const toolExecutor = new ToolExecutor([
  process.cwd(),
  process.env.HOME || '/',
  '/tmp',
  ...(process.env.FLOYD_TOOL_PATHS ? process.env.FLOYD_TOOL_PATHS.split(':').filter(Boolean) : []),
]);

// Initialize managers
let skillsManager: SkillsManager;
let projectsManager: ProjectsManager;
let broworkManager: BroworkManager;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
// 50MB JSON limit to support base64-encoded attachments in chat requests
app.use(express.json({ limit: '50mb' }));

// Multer for file/folder uploads (photos, videos, documents, code)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedExt = /\.(jpe?g|png|gif|webp|tiff?|pdf|docx?|txt|md|mp4|mov|webm|avi|js|ts|tsx|jsx|py|java|c|cpp|cs|go|rb|php|html|css|json|xml|ya?ml|csv)$/i;
    const allowedMime = /^(image|video|text)\/|pdf|document|json|xml|yaml|javascript|typescript|markdown|octet-stream/i;
    if (allowedExt.test(file.originalname) || allowedMime.test(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error(`Invalid file type: ${file.originalname}`));
  },
});

// Serve static frontend files from dist/
const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));

// Data directory for sessions and settings
// Session/settings data lives in the user's runtime root (installed app
// directories are read-only); the legacy in-tree .floyd-data is a dev fallback.
const DATA_DIR = process.env.FLOYD_RUNTIME_ROOT
    ? path.join(process.env.FLOYD_RUNTIME_ROOT, 'desktop-data')
    : path.join(__dirname, '../.floyd-data');

// Types
interface Attachment {
  id: string;
  name: string;
  size: number;
  type: 'image' | 'video' | 'document' | 'code' | 'data';
  mimeType: string;
  data: string; // base64
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
  attachments?: Attachment[];
  /** Recorded when the Vault served this reply through its GLM fallback. */
  fallback?: { provider: string; model: string | null } | null;
}

interface Session {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: Message[];
  customTitle?: string;  // Phase 1, Task 1.1
  messageCount?: number;
  pinned?: boolean;       // Phase 1, Task 1.4
  archived?: boolean;     // Phase 3, Task 3.3
  folder?: string;        // Phase 3, Task 3.2
}

type Provider = 'chatgpt-subscription' | 'anthropic' | 'openai' | 'glm' | 'anthropic-compatible';

interface Settings {
  provider: Provider;
  model: string;
  connectorId?: string;
  systemPrompt?: string;
  maxTokens?: number;
  showToolCalls?: boolean;
}

const VAULT_URL = String(process.env.FLOYD_VAULT_PROXY_URL || '').replace(/\/+$/, '');
const VAULT_TOKEN = String(process.env.FLOYD_VAULT_PROXY_TOKEN || '');
if (!/^fv_/.test(VAULT_TOKEN) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(VAULT_URL)) {
  throw new Error('Floyd Desktop requires its fv_ capability and loopback Vault address');
}
function vaultBaseURL(provider: Provider): string {
  if (provider === 'anthropic-compatible') {
    if (!settings.connectorId) throw new Error('Select a configured Anthropic-compatible Vault connector');
    return vaultConnectorBaseURL(VAULT_URL, settings.connectorId);
  }
  if (provider === 'glm') return `${VAULT_URL}/p/zai/api/coding/paas/v4`;
  if (provider === 'anthropic') return `${VAULT_URL}/p/anthropic`;
  return `${VAULT_URL}/v1`;
}

async function desktopConnectorCatalog(): Promise<DesktopModelConnector[]> {
  return listVaultModelConnectors({ vaultUrl: VAULT_URL, vaultToken: VAULT_TOKEN });
}

async function desktopVaultReadiness(signal?: AbortSignal): Promise<{
  connectors: DesktopModelConnector[];
  ready: boolean;
}> {
  const [connectors, status] = await Promise.all([
    listVaultModelConnectors({ vaultUrl: VAULT_URL, vaultToken: VAULT_TOKEN, signal }),
    readDesktopVaultStatus({ vaultUrl: VAULT_URL, vaultToken: VAULT_TOKEN, signal }),
  ]);
  return {
    connectors,
    ready: isDesktopProviderReady(settings.provider, settings.connectorId, status, connectors),
  };
}

// Model choice is user-configurable; credentials and addresses are not.
// Desktop exception (locked by Douglas 2026-07-31): THIS surface defaults
// to GPT-5.6 Terra on the ChatGPT subscription — the GLM-default rule does
// not apply here. GLM remains the fallback when a saved provider loses its
// credential (boot policy in initDataDir).
let settings: Settings = {
  provider: 'chatgpt-subscription',
  model: 'gpt-5.6-terra',
  maxTokens: 32768,
};

// ChatGPT subscription client (single instance; owns token refresh)
const chatgptClient = new ChatGPTSubscriptionClient();

// Floyd Core experience sync (P5 continuity). Null when Core is unreachable:
// every publish then degrades to a no-op and boot/chat continue unaffected.
let experienceSync: DesktopExperienceCoordinator | null = null;
let latestExperienceState: DesktopExperienceState | null = null;

// Sessions store
const sessions: Map<string, Session> = new Map();

// Initialize data directory
async function initDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    // Load settings if exists
    let hasSavedSettings = false;
    try {
      const settingsData = await fs.readFile(path.join(DATA_DIR, 'settings.json'), 'utf-8');
      const saved = JSON.parse(settingsData) as Partial<Settings>;
      settings = {
        ...settings,
        ...(saved.provider ? { provider: saved.provider } : {}),
        ...(saved.model ? { model: saved.model } : {}),
        ...(typeof saved.connectorId === 'string' ? { connectorId: saved.connectorId } : {}),
        ...(typeof saved.systemPrompt === 'string' ? { systemPrompt: saved.systemPrompt } : {}),
        ...(typeof saved.maxTokens === 'number' ? { maxTokens: saved.maxTokens } : {}),
        ...(typeof saved.showToolCalls === 'boolean' ? { showToolCalls: saved.showToolCalls } : {}),
      };
      hasSavedSettings = true;
      console.log('[Server] Loaded settings from disk');
    } catch {
      console.log('[Server] No existing settings, using defaults');
    }

    // Boot policy. First run: seed the desktop default — GPT-5.6 Terra on
    // the ChatGPT subscription (desktop exception to the GLM default rule).
    // Saved provider whose credential is gone (readiness succeeded and says
    // not-ready): re-seed GLM live and persist, so the UI shows what is
    // actually active. Vault unreachable at boot proves nothing: keep saved.
    const bootReadiness = hasSavedSettings
      ? await desktopVaultReadiness(AbortSignal.timeout(5000)).catch(() => null)
      : null;
    if (!hasSavedSettings) {
      settings = { ...settings, provider: 'chatgpt-subscription', model: 'gpt-5.6-terra' };
      delete settings.connectorId;
      console.log('[Server] Seeded first-run default: ChatGPT subscription (gpt-5.6-terra)');
    } else if (bootReadiness?.ready === false) {
      const glmSeedModel = await resolveGlmSeedModel({ vaultUrl: VAULT_URL, vaultToken: VAULT_TOKEN });
      const boot = resolveBootProviderModel({
        savedProvider: settings.provider,
        savedModel: settings.model,
        savedProviderReady: bootReadiness.ready,
        glmSeedModel,
      });
      settings = { ...settings, provider: boot.provider, model: boot.model };
      delete settings.connectorId;
      if (boot.persist) {
        console.log(`[Server] Saved provider lost its Vault key; re-seeded to GLM (${boot.model})`);
        await saveSettings();
      }
    }
    
    // Load sessions if exists
    try {
      const sessionsDir = path.join(DATA_DIR, 'sessions');
      await fs.mkdir(sessionsDir, { recursive: true });
      const files = await fs.readdir(sessionsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const data = await fs.readFile(path.join(sessionsDir, file), 'utf-8');
          const session = JSON.parse(data) as Session;
          sessions.set(session.id, session);
        }
      }
      console.log(`[Server] Loaded ${sessions.size} sessions from disk`);
    } catch {
      console.log('[Server] No existing sessions');
    }
    
    // Initialize skills manager
    skillsManager = new SkillsManager(DATA_DIR);
    await skillsManager.init();
    console.log(`[Server] Loaded ${skillsManager.getAll().length} skills`);
    
    // Initialize projects manager
    projectsManager = new ProjectsManager(DATA_DIR);
    await projectsManager.init();
    console.log(`[Server] Loaded ${projectsManager.getAll().length} projects`);
    
    // Initialize browork manager
    broworkManager = new BroworkManager(toolExecutor);
    broworkManager.configureVault(VAULT_TOKEN, VAULT_URL);
    broworkManager.setModel(settings.model);
    broworkManager.setProvider(settings.provider);
    broworkManager.setConnector(settings.connectorId);
    broworkManager.setChatGPTClient(chatgptClient);
    console.log('[Server] Browork manager initialized');
    
  } catch (error) {
    console.error('[Server] Failed to init data dir:', error);
  }
}

// Save settings to disk
async function saveSettings() {
  try {
    await fs.writeFile(
      path.join(DATA_DIR, 'settings.json'),
      JSON.stringify(settings, null, 2)
    );
  } catch (error) {
    console.error('[Server] Failed to save settings:', error);
  }
}

// Save session to disk
async function saveSession(session: Session) {
  try {
    const sessionsDir = path.join(DATA_DIR, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, `${session.id}.json`),
      JSON.stringify(session, null, 2)
    );
  } catch (error) {
    console.error('[Server] Failed to save session:', error);
  }
}

// Create API clients. An optional fetch wrapper (e.g. captureVaultFallback)
// lets callers observe upstream Vault response headers.
function getAnthropicClient(fetchImpl?: typeof globalThis.fetch): Anthropic | null {
  if (settings.provider !== 'anthropic' && settings.provider !== 'anthropic-compatible') {
    return null;
  }
  if (settings.provider === 'anthropic-compatible' && !settings.connectorId) return null;
  return new Anthropic({
    apiKey: VAULT_TOKEN,
    baseURL: vaultBaseURL(settings.provider),
    fetch: fetchImpl,
  });
}

function getOpenAIClient(fetchImpl?: typeof globalThis.fetch): OpenAI | null {
  if (settings.provider !== 'openai' && settings.provider !== 'glm') {
    return null;
  }
  return new OpenAI({
    apiKey: VAULT_TOKEN,
    baseURL: vaultBaseURL(settings.provider),
    fetch: fetchImpl,
  });
}

// Unified client getter
function getClient(fetchImpl?: typeof globalThis.fetch): Anthropic | OpenAI | null {
  if (settings.provider === 'openai' || settings.provider === 'glm') {
    return getOpenAIClient(fetchImpl);
  } else if (settings.provider === 'anthropic' || settings.provider === 'anthropic-compatible') {
    return getAnthropicClient(fetchImpl);
  }
  return null;
}

/**
 * Emit an SSE `fallback` event when the Vault served a reply through its GLM
 * fallback. The failure must be visible: the operator sees which provider
 * failed and which model actually answered. Dedupes per response.
 */
function makeFallbackNotifier(res: express.Response): (notice: VaultFallbackNotice | null | undefined) => void {
  let emitted: string | null = null;
  return (notice) => {
    if (!notice) return;
    const key = `${notice.provider}|${notice.model ?? ''}`;
    if (key === emitted) return;
    emitted = key;
    res.write(`data: ${JSON.stringify({ type: 'fallback', provider: notice.provider, model: notice.model })}\n\n`);
  };
}

// ============ API Routes ============

// Health check
app.get('/api/health', async (req, res) => {
  const { ready: hasCredentials } = await desktopVaultReadiness();
  res.json({ 
    status: 'ok', 
    hasApiKey: hasCredentials,
    provider: settings.provider,
    model: settings.model,
    identity: SURFACE_IDENTITY,
  });
});

// Get available providers and models. Model lists are fetched live through
// the Vault credential proxy where a list route exists; the static lists are
// served as offline fallback, with `modelSources` recording which path each
// provider's list took.
app.get('/api/providers', async (_req, res) => {
  const [chatgptStatus, connectors, modelLists] = await Promise.all([
    chatgptClient.status(),
    desktopConnectorCatalog(),
    resolveDesktopProviderModels({ vaultUrl: VAULT_URL, vaultToken: VAULT_TOKEN }),
  ]);
  res.json({
    providers: [
      { id: 'chatgpt-subscription', name: 'ChatGPT Subscription (OAuth)', configured: chatgptStatus.configured },
      { id: 'anthropic', name: 'Anthropic' },
      { id: 'anthropic-compatible', name: 'Anthropic-Compatible (Custom Endpoint)' },
      { id: 'openai', name: 'OpenAI' },
      { id: 'glm', name: 'Zai GLM (Zhipu)' },
    ],
    models: modelLists.models,
    modelSources: modelLists.sources,
    connectors,
    chatgpt: chatgptStatus,
  });
});

// Get settings
app.get('/api/settings', async (_req, res) => {
  const { connectors, ready } = await desktopVaultReadiness();
  res.json({
    provider: settings.provider,
    model: settings.model,
    connectorId: settings.connectorId,
    connectors,
    hasApiKey: ready,
    apiKeyPreview: ready ? 'Managed by Vault' : null,
    systemPrompt: settings.systemPrompt,
    // The prompt actually used when systemPrompt is empty — shown in the UI so
    // the operator always sees what the agent knows about its capabilities.
    effectiveSystemPrompt: settings.systemPrompt || buildDefaultSystemPrompt({ gatewayAvailable: gatewayAvailable(), chronoAvailable: chronoToolsAvailable() }),
    maxTokens: settings.maxTokens,
    showToolCalls: settings.showToolCalls ?? false,
  });
});

// Update settings
app.post('/api/settings', async (req, res) => {
  const { provider, model, connectorId, systemPrompt, maxTokens, showToolCalls } = req.body;
  if ('apiKey' in req.body || 'baseURL' in req.body) {
    return res.status(400).json({ error: 'Provider credentials and addresses are managed by Vault.' });
  }

  const nextProvider = provider ?? settings.provider;
  const nextConnectorId = connectorId ?? settings.connectorId;
  if (nextProvider === 'anthropic-compatible') {
    const connectors = await desktopConnectorCatalog();
    const selected = connectors.find((connector) =>
      connector.id === nextConnectorId
      && connector.dialect === 'anthropic'
      && connector.configured);
    if (!selected) {
      return res.status(400).json({ error: 'Select a configured Anthropic-compatible connector from Floyd Vault.' });
    }
  }

  settings = {
    ...settings,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(connectorId !== undefined ? { connectorId } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(showToolCalls !== undefined ? { showToolCalls: !!showToolCalls } : {}),
  };

  broworkManager.setModel(settings.model);
  broworkManager.setProvider(settings.provider);
  broworkManager.setConnector(settings.connectorId);
  
  await saveSettings();
  
  res.json({ success: true });
});

app.post('/api/test-key', (_req, res) => {
  res.status(410).json({ success: false, error: 'Direct key testing was removed. Use the Vault application test.' });
});

// === FLOYD CORE EXPERIENCE SYNC (P5 continuity) ===
// The composer draft and selected view are portable across surfaces via
// Core's experience envelope. All endpoints degrade to available:false when
// Core is unreachable; the desktop keeps working without continuity.

// Current restorable experience state (draft, model route, active context)
app.get('/api/experience/state', (_req, res) => {
  if (!experienceSync || !latestExperienceState) {
    return res.json({ available: false });
  }
  res.json({
    available: true,
    composerDraft: latestExperienceState.composerDraft,
    modelRoute: latestExperienceState.modelRoute,
    active: latestExperienceState.active,
    selectedView: latestExperienceState.selectedView,
    revision: latestExperienceState.revision,
  });
});

// Publish composer draft changes (debounced + coalesced server-side)
app.post('/api/experience/draft', (req, res) => {
  const draft = typeof req.body?.draft === 'string' ? req.body.draft : '';
  experienceSync?.publish({ composer_draft: draft });
  res.json({ success: true, available: Boolean(experienceSync) });
});

// Publish selected view changes (chat/settings/skills/projects/browork)
app.post('/api/experience/view', (req, res) => {
  const view = typeof req.body?.view === 'string' ? req.body.view.trim() : '';
  if (!view) {
    return res.status(400).json({ error: 'view is required' });
  }
  experienceSync?.publish({ selected_view: view });
  res.json({ success: true, available: Boolean(experienceSync) });
});

// === SKILLS API ===

// List all skills
app.get('/api/skills', (req, res) => {
  const skills = skillsManager.getAll().map(s => ({
    ...s,
    isActive: skillsManager.isActive(s.id),
  }));
  res.json({ skills });
});

// Get active skills
app.get('/api/skills/active', (req, res) => {
  res.json({ skills: skillsManager.getActiveSkills() });
});

// Create skill
app.post('/api/skills', async (req, res) => {
  const skill = await skillsManager.create(req.body);
  res.json(skill);
});

// Update skill
app.put('/api/skills/:id', async (req, res) => {
  const skill = await skillsManager.update(req.params.id, req.body);
  if (!skill) {
    return res.status(404).json({ error: 'Skill not found' });
  }
  res.json(skill);
});

// Delete skill
app.delete('/api/skills/:id', async (req, res) => {
  const deleted = await skillsManager.delete(req.params.id);
  res.json({ success: deleted });
});

// Activate/deactivate skill
app.post('/api/skills/:id/activate', async (req, res) => {
  const success = await skillsManager.activate(req.params.id);
  if (!success) {
    return res.status(404).json({ success: false, error: 'Skill not found' });
  }
  res.json({ success: true, isActive: true });
});

app.post('/api/skills/:id/deactivate', async (req, res) => {
  const success = await skillsManager.deactivate(req.params.id);
  if (!success) {
    return res.status(404).json({ success: false, error: 'Skill not found' });
  }
  res.json({ success: true, isActive: false });
});

// === PROJECTS API ===

// List all projects
app.get('/api/projects', (req, res) => {
  const projects = projectsManager.getAll();
  const active = projectsManager.getActive();
  res.json({ projects, activeId: active?.id || null });
});

// Get active project
app.get('/api/projects/active', (req, res) => {
  const project = projectsManager.getActive();
  res.json(project);
});

// Create project
app.post('/api/projects', async (req, res) => {
  const project = await projectsManager.create(req.body);
  res.json(project);
});

// Update project
app.put('/api/projects/:id', async (req, res) => {
  const project = await projectsManager.update(req.params.id, req.body);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  res.json(project);
});

// Delete project
app.delete('/api/projects/:id', async (req, res) => {
  const deleted = await projectsManager.delete(req.params.id);
  res.json({ success: deleted });
});

// Set active project
app.post('/api/projects/:id/activate', async (req, res) => {
  await projectsManager.setActive(req.params.id);
  res.json({ success: true });
});

app.post('/api/projects/deactivate', async (req, res) => {
  await projectsManager.setActive(null);
  res.json({ success: true });
});

// Add file to project
app.post('/api/projects/:id/files', async (req, res) => {
  const { path: filePath, type, name, content } = req.body;
  
  let file;
  if (type === 'snippet') {
    file = await projectsManager.addSnippet(req.params.id, name, content);
  } else {
    file = await projectsManager.addFile(req.params.id, filePath);
  }
  
  if (!file) {
    return res.status(400).json({ error: 'Failed to add file' });
  }
  res.json(file);
});

// Remove file from project
app.delete('/api/projects/:id/files', async (req, res) => {
  const { path: filePath } = req.body;
  const removed = await projectsManager.removeFile(req.params.id, filePath);
  res.json({ success: removed });
});

// === BROWORK API (Sub-agent system) ===

// Get all agent tasks
app.get('/api/browork/tasks', (req, res) => {
  res.json({ tasks: broworkManager.getTasks() });
});

// Get single task
app.get('/api/browork/tasks/:id', (req, res) => {
  const task = broworkManager.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

// Create new task
app.post('/api/browork/tasks', (req, res) => {
  const { name, description } = req.body;
  if (!name || !description) {
    return res.status(400).json({ error: 'Name and description required' });
  }
  
  // Make sure browork has current API key
  broworkManager.configureVault(VAULT_TOKEN, VAULT_URL);
  broworkManager.setModel(settings.model);
  broworkManager.setProvider(settings.provider);
  
  const task = broworkManager.createTask(name, description);
  res.json(task);
});

// Start a task
app.post('/api/browork/tasks/:id/start', async (req, res) => {
  try {
    await broworkManager.startTask(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Cancel a task
app.post('/api/browork/tasks/:id/cancel', (req, res) => {
  const cancelled = broworkManager.cancelTask(req.params.id);
  res.json({ success: cancelled });
});

// Delete a task
app.delete('/api/browork/tasks/:id', (req, res) => {
  const deleted = broworkManager.deleteTask(req.params.id);
  res.json({ success: deleted });
});

// Clear finished tasks
app.post('/api/browork/clear', (req, res) => {
  const cleared = broworkManager.clearFinished();
  res.json({ cleared });
});

// Archive/unarchive session (Phase 3, Task 3.3)
app.patch('/api/sessions/:id/archive', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const { archived } = req.body;
  
  // Toggle archived state
  session.archived = archived;
  session.updated = Date.now();
  
  await saveSession(session);
  
  res.json({ 
    success: true, 
    session: {
      id: session.id,
      archived: session.archived,
      updated: session.updated
    }
  });
});

// Assign session to folder (Phase 3, Task 3.2)
app.patch('/api/sessions/:id/folder', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const { folder } = req.body;
  
  // Assign folder (can be empty string to remove from folder)
  session.folder = folder || undefined;
  session.updated = Date.now();
  
  await saveSession(session);
  
  res.json({ 
    success: true, 
    session: {
      id: session.id,
      folder: session.folder,
      updated: session.updated
    }
  });
});

// Get all folders (Phase 3, Task 3.2)
app.get('/api/folders', (req, res) => {
  const folders = new Set<string>();
  
  sessions.forEach(session => {
    if (session.folder) {
      folders.add(session.folder);
    }
  });
  
  res.json({ 
    folders: Array.from(folders).sort()
  });
});

// List sessions (updated to filter by folder and archived status)
app.get('/api/sessions', (req, res) => {
  const { folder, archived } = req.query;
  
  let sessionList = Array.from(sessions.values());
  
  // Filter by folder if specified
  if (folder) {
    sessionList = sessionList.filter(s => s.folder === folder);
  }
  
  // Filter by archived status if specified
  if (archived === 'true') {
    sessionList = sessionList.filter(s => s.archived === true);
  } else if (archived === 'false') {
    sessionList = sessionList.filter(s => !s.archived);
  }
  
  const result = sessionList
    .map(s => ({
      id: s.id,
      title: s.title,
      created: s.created,
      updated: s.updated,
      messageCount: s.messages.length,
      customTitle: s.customTitle,
      pinned: s.pinned,
      archived: s.archived,
      folder: s.folder,
    }))
    .sort((a, b) => b.updated - a.updated);
  
  res.json(result);
});

// Create session
app.post('/api/sessions', async (req, res) => {
  const session: Session = {
    id: uuidv4(),
    title: 'New Chat',
    created: Date.now(),
    updated: Date.now(),
    messages: [],
  };
  
  sessions.set(session.id, session);
  await saveSession(session);
  
  res.json(session);
});

// Get session
app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(session);
});

// Update session
app.put('/api/sessions/:id', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const { title, messages } = req.body;
  if (title !== undefined) session.title = title;
  if (messages !== undefined) session.messages = messages;
  session.updated = Date.now();
  
  await saveSession(session);
  
  res.json(session);
});

// Rename session (Phase 1, Task 1.1)
app.patch('/api/sessions/:id/rename', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const { customTitle } = req.body;
  
  // Allow clearing custom title by setting to null or empty string
  if (customTitle === null || customTitle === '') {
    session.customTitle = undefined;
  } else if (typeof customTitle === 'string' && customTitle.trim().length > 0) {
    session.customTitle = customTitle.trim();
  } else {
    return res.status(400).json({ error: 'Invalid customTitle value' });
  }
  
  session.updated = Date.now();
  
  await saveSession(session);
  
  res.json({ 
    success: true, 
    session: {
      id: session.id,
      title: session.title,
      customTitle: session.customTitle,
      displayTitle: session.customTitle || session.title,
      updated: session.updated
    }
  });
});

// Regenerate last assistant response (Phase 1, Task 1.3)
app.post('/api/sessions/:id/regenerate', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Check if there's at least one assistant message to regenerate
  const lastAssistantIndex = [...session.messages].reverse().findIndex(m => m.role === 'assistant');
  if (lastAssistantIndex === -1) {
    return res.status(400).json({ error: 'No assistant message to regenerate' });
  }

  const actualIndex = session.messages.length - 1 - lastAssistantIndex;
  
  // Remove the last assistant message and any messages after it
  const messagesToKeep = session.messages.slice(0, actualIndex);
  const userMessages = messagesToKeep.filter(m => m.role === 'user');
  
  if (userMessages.length === 0) {
    return res.status(400).json({ error: 'No user message to respond to' });
  }

  // Set up SSE for streaming response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullResponse = '';
  const notifyFallback = makeFallbackNotifier(res);
  let fallbackNotice: VaultFallbackNotice | null = null;
  
  // Build system prompt
  let systemPrompt = settings.systemPrompt || buildDefaultSystemPrompt({ gatewayAvailable: gatewayAvailable(), chronoAvailable: chronoToolsAvailable() });
  
  // Add active skills
  const skillsContext = skillsManager.getSystemPromptAdditions();
  if (skillsContext) {
    systemPrompt += skillsContext;
  }
  
  // Add project context
  const projectContext = await projectsManager.getProjectContext();
  if (projectContext) {
    systemPrompt += projectContext;
  }

  try {
    // Build API messages (excluding tools for regeneration)
    const apiMessages = messagesToKeep
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role,
        content: m.content,
      }));

    if (settings.provider === 'chatgpt-subscription') {
      // ChatGPT subscription flow (regeneration, no tools)
      const input: ResponseInputItem[] = apiMessages.map(m =>
        m.role === 'user'
          ? chatgptUserMessage(m.content)
          : ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] } as ResponseInputItem)
      );
      const turn = await chatgptClient.runTurn({
        model: settings.model,
        instructions: systemPrompt,
        input,
        callbacks: {
          onText: (delta) => {
            fullResponse += delta;
            res.write(`data: ${JSON.stringify({ type: 'text', content: delta })}\n\n`);
          },
          onFallback: (notice) => {
            fallbackNotice = notice;
            notifyFallback(notice);
          },
        },
      });
      fullResponse = turn.text;
    } else if (settings.provider === 'openai' || settings.provider === 'glm') {
      // OpenAI/GLM flow
      const fallbackCap = captureVaultFallback();
      const client = new OpenAI({ 
        apiKey: VAULT_TOKEN,
        baseURL: vaultBaseURL(settings.provider),
        fetch: fallbackCap.fetch,
      });

      const response = await client.chat.completions.create({
        model: settings.model,
        max_tokens: settings.maxTokens || 16384,
        messages: [
          { role: 'system', content: systemPrompt },
          ...apiMessages,
        ],
        stream: true,
      });
      notifyFallback(fallbackCap.notice());
      fallbackNotice = fallbackCap.notice() ?? fallbackNotice;

      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          fullResponse += delta;
          res.write(`data: ${JSON.stringify({ type: 'text', content: delta })}\n\n`);
        }
      }
    } else {
      // Anthropic-compatible flow
      const fallbackCap = captureVaultFallback();
      const client = new Anthropic({ 
        apiKey: VAULT_TOKEN,
        baseURL: vaultBaseURL(settings.provider),
        fetch: fallbackCap.fetch,
      });

      const response = await client.messages.create({
        model: settings.model,
        max_tokens: settings.maxTokens || 16384,
        system: systemPrompt,
        messages: apiMessages,
        stream: true,
      });
      notifyFallback(fallbackCap.notice());
      fallbackNotice = fallbackCap.notice() ?? fallbackNotice;

      for await (const chunk of response) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          const text = chunk.delta.text;
          fullResponse += text;
          res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
        }
      }
    }

    // Update session with regenerated response
    session.messages = messagesToKeep;
    session.messages.push({
      role: 'assistant',
      content: fullResponse,
      timestamp: Date.now(),
      ...(fallbackNotice ? { fallback: fallbackNotice } : {}),
    });
    session.updated = Date.now();
    await saveSession(session);

    res.write(`data: ${JSON.stringify({ 
      type: 'done',
      content: fullResponse,
      sessionId: session.id
    })}\n\n`);
    res.end();

  } catch (error: any) {
    console.error('[Server] Regenerate error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// Pin/unpin session (Phase 1, Task 1.4)
app.patch('/api/sessions/:id/pin', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const { pinned } = req.body;
  
  // Toggle pinned state
  session.pinned = pinned;
  session.updated = Date.now();
  
  await saveSession(session);
  
  res.json({ 
    success: true, 
    session: {
      id: session.id,
      pinned: session.pinned,
      updated: session.updated
    }
  });
});

// Continue response (Phase 2, Task 2.2)
app.post('/api/sessions/:id/continue', async (req, res) => {
  const { id } = req.params;
  
  const session = sessions.get(id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  if (session.messages.length === 0) {
    return res.status(400).json({ error: 'No messages to continue from' });
  }
  
  const lastMessage = session.messages[session.messages.length - 1];
  if (lastMessage.role !== 'assistant') {
    return res.status(400).json({ error: 'Last message is not from assistant' });
  }
  
  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const notifyFallback = makeFallbackNotifier(res);
  
  try {
    const client = getClient();
    if (!client) {
      return res.status(400).json({ error: 'API key not configured' });
    }
    
    // Build system prompt with context
    let systemPrompt = settings.systemPrompt || buildDefaultSystemPrompt({ gatewayAvailable: gatewayAvailable(), chronoAvailable: chronoToolsAvailable() });
    const skillsContext = skillsManager.getSystemPromptAdditions();
    if (skillsContext) {
      systemPrompt += skillsContext;
    }
    const projectContext = await projectsManager.getProjectContext();
    if (projectContext) {
      systemPrompt += projectContext;
    }
    
    // Build messages array, excluding the last incomplete assistant message
    const apiMessages = session.messages.slice(0, -1).map(m => ({
      role: m.role,
      content: m.content,
    }));
    
    let continuedContent = lastMessage.content;
    
    // Stream the continuation
    if (settings.provider === 'chatgpt-subscription') {
      const input: ResponseInputItem[] = apiMessages.map((m: any) =>
        m.role === 'user'
          ? chatgptUserMessage(m.content)
          : ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] } as ResponseInputItem)
      );
      input.push(chatgptUserMessage(`Continue your previous reply exactly where it left off. Do not repeat what was already written. Previous partial reply:\n\n${continuedContent}`));
      const turn = await chatgptClient.runTurn({
        model: settings.model,
        instructions: systemPrompt,
        input,
      });
      notifyFallback(turn.fallback);
      if (turn.text) {
        continuedContent += turn.text;
        res.write(`data: ${JSON.stringify({ type: 'text', content: turn.text })}\n\n`);
      }

      session.messages[session.messages.length - 1] = {
        role: 'assistant',
        content: continuedContent,
        timestamp: Date.now(),
      };
      session.updated = Date.now();
      await saveSession(session);

      res.write(`data: ${JSON.stringify({ type: 'done', content: continuedContent })}\n\n`);
      res.end();

    } else if (settings.provider === 'openai' || settings.provider === 'glm') {
      const fallbackCap = captureVaultFallback();
      const openaiClient = new OpenAI({ 
        apiKey: VAULT_TOKEN,
        baseURL: vaultBaseURL(settings.provider),
        fetch: fallbackCap.fetch,
      });
      
      const response = await openaiClient.chat.completions.create({
        model: settings.model,
        max_tokens: settings.maxTokens || 8192,
        messages: [
          { role: 'system', content: systemPrompt },
          ...apiMessages,
          { role: 'assistant', content: continuedContent }, // Include partial response
        ],
      });
      notifyFallback(fallbackCap.notice());
      
      const assistantMessage = response.choices[0].message;
      if (assistantMessage.content) {
        continuedContent += assistantMessage.content;
        res.write(`data: ${JSON.stringify({ type: 'text', content: assistantMessage.content })}\n\n`);
      }
      
      // Update session with continued message
      session.messages[session.messages.length - 1] = {
        role: 'assistant',
        content: continuedContent,
        timestamp: Date.now(),
      };
      session.updated = Date.now();
      await saveSession(session);
      
      res.write(`data: ${JSON.stringify({ type: 'done', content: continuedContent })}\n\n`);
      res.end();
      
    } else {
      // Anthropic-compatible flow
      const fallbackCap = captureVaultFallback();
      const anthropicClient = new Anthropic({ 
        apiKey: VAULT_TOKEN,
        baseURL: vaultBaseURL(settings.provider),
        fetch: fallbackCap.fetch,
      });
      
      const response = await anthropicClient.messages.create({
        model: settings.model,
        max_tokens: settings.maxTokens || 8192,
        system: systemPrompt,
        messages: [
          ...apiMessages,
          { role: 'assistant', content: continuedContent }, // Include partial response
        ],
      });
      notifyFallback(fallbackCap.notice());
      
      for (const block of response.content) {
        if (block.type === 'text') {
          continuedContent += block.text;
          res.write(`data: ${JSON.stringify({ type: 'text', content: block.text })}\n\n`);
        }
      }
      
      // Update session with continued message
      session.messages[session.messages.length - 1] = {
        role: 'assistant',
        content: continuedContent,
        timestamp: Date.now(),
      };
      session.updated = Date.now();
      await saveSession(session);
      
      res.write(`data: ${JSON.stringify({ type: 'done', content: continuedContent })}\n\n`);
      res.end();
    }
    
  } catch (error: any) {
    console.error('[Server] Continue error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// Edit user message (Phase 2, Task 2.1)
app.patch('/api/sessions/:id/messages/:messageIndex', async (req, res) => {
  const { id } = req.params;
  const messageIndex = parseInt(req.params.messageIndex);
  const { content } = req.body;
  
  const session = sessions.get(id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  if (messageIndex < 0 || messageIndex >= session.messages.length) {
    return res.status(400).json({ error: 'Invalid message index' });
  }
  
  const message = session.messages[messageIndex];
  
  if (message.role !== 'user') {
    return res.status(400).json({ error: 'Can only edit user messages' });
  }
  
  // Update the message content
  message.content = content;
  session.updated = Date.now();
  
  // Remove all messages after the edited one (cascading delete)
  session.messages = session.messages.slice(0, messageIndex + 1);
  
  // Save the session
  await saveSession(session);
  
  res.json({ 
    success: true,
    messages: session.messages,
    session: {
      id: session.id,
      title: session.title,
      customTitle: session.customTitle,
      updated: session.updated,
      messageCount: session.messages.length
    }
  });
});

// Delete session
app.delete('/api/sessions/:id', async (req, res) => {
  const id = req.params.id;
  sessions.delete(id);
  
  try {
    await fs.unlink(path.join(DATA_DIR, 'sessions', `${id}.json`));
  } catch {
    // Ignore if file doesn't exist
  }
  
  res.json({ success: true });
});

// Send message (non-streaming)
app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  
  const usingChatGPT = settings.provider === 'chatgpt-subscription';
  const fallbackCap = captureVaultFallback();
  const client = usingChatGPT ? null : getClient(fallbackCap.fetch);
  if (usingChatGPT) {
    if (!(await chatgptClient.isConfigured())) {
      return res.status(400).json({ error: 'ChatGPT subscription is not configured in Floyd Vault.' });
    }
  } else if (!client) {
    return res.status(400).json({ error: 'API key not configured' });
  }
  
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId || uuidv4(),
      title: message.slice(0, 50) + (message.length > 50 ? '...' : ''),
      created: Date.now(),
      updated: Date.now(),
      messages: [],
    };
    sessions.set(session.id, session);
  }
  
  // Add user message
  session.messages.push({
    role: 'user',
    content: message,
    timestamp: Date.now(),
  });
  
  try {
    let assistantContent: string;
    let usage: unknown = undefined;
    let fallbackNotice: VaultFallbackNotice | null = null;
    if (usingChatGPT) {
      const input: ResponseInputItem[] = session.messages.map(m =>
        m.role === 'user'
          ? chatgptUserMessage(m.content)
          : ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] } as ResponseInputItem)
      );
      const turn = await chatgptClient.runTurn({
        model: settings.model,
        instructions: settings.systemPrompt || buildDefaultSystemPrompt({ gatewayAvailable: gatewayAvailable(), chronoAvailable: chronoToolsAvailable() }),
        input,
      });
      assistantContent = turn.text;
      fallbackNotice = turn.fallback ?? null;
    } else {
      const response = await (client as Anthropic).messages.create({
        model: settings.model,
        max_tokens: settings.maxTokens || 8192,
        system: settings.systemPrompt,
        messages: session.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      });
      fallbackNotice = fallbackCap.notice();
      assistantContent = response.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('\n');
      usage = response.usage;
    }
    
    // Add assistant message
    session.messages.push({
      role: 'assistant',
      content: assistantContent,
      timestamp: Date.now(),
      ...(fallbackNotice ? { fallback: fallbackNotice } : {}),
    });
    
    session.updated = Date.now();
    await saveSession(session);
    
    res.json({
      success: true,
      response: assistantContent,
      usage,
      fallback: fallbackNotice,
      session: {
        id: session.id,
        title: session.title,
      },
    });
  } catch (error: any) {
    console.error('[Server] Chat error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to get response' 
    });
  }
});

// Get available tools
app.get('/api/tools', (req, res) => {
  res.json({ tools: getAgentTools() });
});

// Execute a tool directly
app.post('/api/tools/execute', async (req, res) => {
  const { name, args } = req.body;
  const result = await executeAgentTool(name, args);
  res.json(result);
});

// Convert built-in tools to Anthropic format
function getAnthropicTools(): Anthropic.Tool[] {
  return getAgentTools().map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as { type: 'object'; properties: Record<string, unknown>; required?: string[] },
  })) as Anthropic.Tool[];
}

// Convert tools to OpenAI format
function getOpenAITools() {
  return getAgentTools().map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

// Convert tools to ChatGPT Responses-API format
function getChatGPTTools() {
  return getAgentTools().map(tool => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as Record<string, unknown>,
  }));
}

// ---- Browork dispatch tools -------------------------------------------------
// Expose sub-agent dispatch to the chat agent so it can delegate parallel work.
const BROWORK_TOOLS = [
  {
    name: 'browork_create_task',
    description: 'Create a Browork sub-agent task. Sub-agents run autonomously in parallel with access to file system, terminal, and code execution tools. Returns the task id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short task name' },
        description: { type: 'string', description: 'Detailed instructions for the sub-agent' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'browork_start_task',
    description: 'Start a previously created Browork task. The sub-agent begins working immediately.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task id from browork_create_task' } },
      required: ['taskId'],
    },
  },
  {
    name: 'browork_list_tasks',
    description: 'List all Browork sub-agent tasks with status and progress.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browork_get_task',
    description: 'Get full detail of one Browork task: status, progress, logs, tool calls, and result. Poll this after starting a task.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
];

/** Full tool surface offered to the chat agent. */
function getAgentTools() {
  return [
    ...BUILTIN_TOOLS,
    ...BROWORK_TOOLS,
    ...(gatewayAvailable() ? GATEWAY_TOOLS : []),
    ...(chronoToolsAvailable() ? CHRONO_TOOLS : []),
  ];
}

/** Execute a tool call from the chat agent, routing Browork tools to the manager. */
async function executeAgentTool(name: string, args: Record<string, unknown>): Promise<{ success: boolean; result?: any; error?: string }> {
  try {
    if (isGatewayTool(name)) {
      return await executeGatewayTool(name, args);
    }
    if (isChronoTool(name)) {
      return await executeChronoTool(name, args);
    }
    switch (name) {
      case 'browork_create_task': {
        const task = broworkManager.createTask(String(args.name || 'Unnamed task'), String(args.description || ''));
        return { success: true, result: { taskId: task.id, status: task.status } };
      }
      case 'browork_start_task': {
        await broworkManager.startTask(String(args.taskId));
        return { success: true, result: { taskId: args.taskId, status: 'running' } };
      }
      case 'browork_list_tasks': {
        const tasks = broworkManager.getTasks().map(t => ({ id: t.id, name: t.name, status: t.status, progress: t.progress }));
        return { success: true, result: { tasks } };
      }
      case 'browork_get_task': {
        const task = broworkManager.getTask(String(args.taskId));
        if (!task) return { success: false, error: 'Task not found' };
        return { success: true, result: task };
      }
      default: {
        const result = await toolExecutor.execute(name, args);
        chronoAfterToolCall(name, args, result.success);
        return result;
      }
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ---- Attachment helpers ----------------------------------------------------
// Convert uploaded attachments into provider-specific content blocks.
function attachmentTextBlock(att: Attachment): string | null {
  // Inline code/data/plain-text files as fenced text the model can read.
  const textLike = att.type === 'code' || att.type === 'data' ||
    (att.mimeType || '').startsWith('text/') || (att.mimeType || '').includes('markdown');
  if (!textLike) return null;
  try {
    const text = Buffer.from(att.data, 'base64').toString('utf8');
    return `[Attached file: ${att.name}]\n\`\`\`\n${text}\n\`\`\``;
  } catch {
    return null;
  }
}

function buildUserContent(provider: Provider, content: string, attachments?: Attachment[]): any {
  if (!attachments || attachments.length === 0) return content;
  const blocks: any[] = [];
  for (const att of attachments) {
    if (att.type === 'image') {
      if (provider === 'openai' || provider === 'glm') {
        blocks.push({ type: 'image_url', image_url: { url: `data:${att.mimeType || 'image/jpeg'};base64,${att.data}` } });
      } else {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: att.mimeType || 'image/jpeg', data: att.data } });
      }
      continue;
    }
    if ((att.mimeType || '') === 'application/pdf' && provider !== 'openai' && provider !== 'glm') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: att.data } });
      continue;
    }
    const textBlock = attachmentTextBlock(att);
    if (textBlock) {
      blocks.push({ type: 'text', text: textBlock });
    } else {
      blocks.push({ type: 'text', text: `[Attachment "${att.name}" (${att.mimeType}, ${att.size} bytes) was uploaded but this file type cannot be read directly by the current provider.]` });
    }
  }
  blocks.push({ type: 'text', text: content });
  return blocks;
}

// ChatGPT subscription path: images ride input_image, text-like files are inlined.
function chatgptMessageParts(content: string, attachments?: Attachment[]): { text: string; images: Array<{ mediaType: string; base64: string }> } {
  if (!attachments || attachments.length === 0) return { text: content, images: [] };
  const images: Array<{ mediaType: string; base64: string }> = [];
  let text = '';
  for (const att of attachments) {
    if (att.type === 'image') {
      images.push({ mediaType: att.mimeType || 'image/jpeg', base64: att.data });
      continue;
    }
    const textBlock = attachmentTextBlock(att);
    if (textBlock) text += textBlock + '\n\n';
    else text += `[Attachment "${att.name}" (${att.mimeType}, ${att.size} bytes) was uploaded but cannot be read directly.]\n\n`;
  }
  text += content;
  return { text, images };
}

// File upload endpoint: accepts photos, videos, documents, code, and folder
// contents (folders arrive as their constituent files with relative paths).
app.post('/api/upload', upload.array('files', 100), async (req, res) => {
  try {
    if (!req.files || (req.files as Express.Multer.File[]).length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const files = req.files as Express.Multer.File[];
    const uploadedFiles = files.map(file => {
      const fileType = file.mimetype.startsWith('image/') ? 'image' :
                       file.mimetype.startsWith('video/') ? 'video' :
                       file.mimetype.includes('pdf') || file.mimetype.includes('document') ? 'document' :
                       file.mimetype.includes('text') || file.mimetype.includes('markdown') ? 'code' :
                       'data';

      return {
        id: uuidv4(),
        name: file.originalname,
        size: file.size,
        type: fileType,
        mimeType: file.mimetype,
        data: file.buffer.toString('base64'),
      };
    });

    res.json({ success: true, files: uploadedFiles });
  } catch (error: any) {
    console.error('[Server] Upload error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to upload files' });
  }
});

// Send message (streaming with tool use) - supports both Anthropic and OpenAI
app.post('/api/chat/stream', async (req, res) => {
  const { sessionId, message = '', enableTools = true, attachments = [] } = req.body as { sessionId: string; message?: string; enableTools?: boolean; attachments?: Attachment[] };

  if (!message && attachments.length === 0) {
    return res.status(400).json({ error: 'Message or attachments are required' });
  }
  
  if (settings.provider === 'chatgpt-subscription') {
    if (!(await chatgptClient.isConfigured())) {
      return res.status(400).json({ error: 'ChatGPT subscription is not configured in Floyd Vault.' });
    }
  } else if (!VAULT_TOKEN) {
    return res.status(400).json({ error: 'API key not configured' });
  }
  
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId || uuidv4(),
      title: (message || 'Attachments').slice(0, 50) + (message.length > 50 ? '...' : ''),
      created: Date.now(),
      updated: Date.now(),
      messages: [],
    };
    sessions.set(session.id, session);
  }
  
  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Build messages for API
  const apiMessages: any[] = [];
  
  // Add existing session messages (attachment-aware for user turns)
  for (const m of session.messages) {
    if (m.role === 'user') {
      apiMessages.push({ role: 'user', content: buildUserContent(settings.provider, m.content, m.attachments) });
    } else if (m.role === 'assistant') {
      apiMessages.push({ role: m.role, content: m.content });
    }
  }
  
  // Add new user message
  apiMessages.push({ role: 'user', content: buildUserContent(settings.provider, message, attachments) });
  session.messages.push({ role: 'user', content: message, timestamp: Date.now(), attachments: attachments.length > 0 ? attachments : undefined });
  
  let fullResponse = '';
  let turnCount = 0;
  const maxTurns = 10;
  // Vault GLM-fallback visibility: surface any fallback to the client and
  // record it on the saved assistant message.
  const notifyFallback = makeFallbackNotifier(res);
  let fallbackNotice: VaultFallbackNotice | null = null;

  // Never-silent completion + truncation tracking (see completion-guard.ts).
  const executedTools: string[] = [];
  let truncated = false;

  // Client abort: when the connection dies (Stop button, tab closed), stop
  // the provider loop between turns and never write to the dead response.
  let clientDisconnected = false;
  res.on('close', () => {
    if (!res.writableEnded) clientDisconnected = true;
  });
  const sendEvent = (payload: Record<string, unknown>) => {
    if (clientDisconnected) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const activity = (turn: number, tool?: string) => {
    sendEvent({ type: 'activity', turn, ...(tool ? { tool } : {}) });
  };
  
  // Build system prompt with skills and project context
  let systemPrompt = settings.systemPrompt || buildDefaultSystemPrompt({ gatewayAvailable: gatewayAvailable(), chronoAvailable: chronoToolsAvailable() });
  
  // Add active skills
  const skillsContext = skillsManager.getSystemPromptAdditions();
  if (skillsContext) {
    systemPrompt += skillsContext;
  }
  
  // Add project context
  const projectContext = await projectsManager.getProjectContext();
  if (projectContext) {
    systemPrompt += projectContext;
  }
  
  try {
    if (settings.provider === 'chatgpt-subscription') {
      // ChatGPT subscription (OAuth) flow — Responses API with tools + vision
      const chatgptTools = enableTools ? getChatGPTTools() : undefined;
      const input: ResponseInputItem[] = [];
      for (const m of session.messages) {
        if (m.role === 'user') {
          const parts = chatgptMessageParts(m.content, m.attachments);
          input.push(chatgptUserMessage(parts.text, parts.images.length > 0 ? parts.images : undefined));
        } else if (m.role === 'assistant') {
          input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
        }
      }

      while (turnCount < maxTurns && !clientDisconnected) {
        turnCount++;
        activity(turnCount);
        const turn = await chatgptClient.runTurn({
          model: settings.model,
          instructions: systemPrompt,
          input,
          tools: chatgptTools,
          callbacks: {
            onText: (delta) => {
              fullResponse += delta;
              sendEvent({ type: 'text', content: delta });
            },
            onFallback: (notice) => {
              fallbackNotice = notice;
              notifyFallback(notice);
            },
          },
        });
        if (turn.truncated) truncated = true;

        input.push(...turn.outputItems);

        if (turn.toolCalls.length === 0) break;

        for (const call of turn.toolCalls) {
          if (clientDisconnected) break;
          activity(turnCount, call.name);
          executedTools.push(call.name);
          sendEvent({ type: 'tool_call', tool: call.name, args: call.args, id: call.callId });
          const result = await executeAgentTool(call.name, call.args);
          sendEvent({ type: 'tool_result', tool: call.name, id: call.callId, result: result.success ? result.result : { error: result.error }, success: result.success });
          input.push(chatgptToolResult(call.callId, result.success ? result.result : { error: result.error }));
        }
      }
    } else if (settings.provider === 'openai' || settings.provider === 'glm') {
      // OpenAI-compatible flow (OpenAI and GLM)
      const fallbackCap = captureVaultFallback();
      const client = new OpenAI({ 
        apiKey: VAULT_TOKEN,
        baseURL: vaultBaseURL(settings.provider),
        fetch: fallbackCap.fetch,
      });
      const openaiTools = enableTools ? getOpenAITools() : undefined;
      
      while (turnCount < maxTurns && !clientDisconnected) {
        turnCount++;
        activity(turnCount);

        const response = await client.chat.completions.create({
          model: settings.model,
          max_tokens: settings.maxTokens || 32768,
          messages: [
            { role: 'system', content: systemPrompt },
            ...apiMessages,
          ],
          tools: openaiTools,
        });
        notifyFallback(fallbackCap.notice());
        fallbackNotice = fallbackCap.notice() ?? fallbackNotice;

        const choice = response.choices[0];
        const assistantMessage = choice.message;
        // Provider cut the answer off at the Max Tokens limit.
        if (choice.finish_reason === 'length') truncated = true;

        // Handle text content
        if (assistantMessage.content) {
          fullResponse += assistantMessage.content;
          sendEvent({ type: 'text', content: assistantMessage.content });
        }

        // Handle tool calls
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          apiMessages.push(assistantMessage);

          for (const toolCall of assistantMessage.tool_calls) {
            if (clientDisconnected) break;
            // Type narrowing: only function-type calls have the .function property
            if (toolCall.type !== 'function') continue;
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);
            activity(turnCount, toolName);
            executedTools.push(toolName);

            // Send tool call info to client
            sendEvent({
              type: 'tool_call',
              tool: toolName,
              args: toolArgs,
              id: toolCall.id
            });

            // Execute tool
            const result = await executeAgentTool(toolName, toolArgs);

            // Send tool result to client
            sendEvent({
              type: 'tool_result',
              tool: toolName,
              id: toolCall.id,
              result: result.success ? result.result : { error: result.error },
              success: result.success
            });

            // Add tool result to messages
            apiMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(result.success ? result.result : { error: result.error }),
            });
          }
        } else {
          // No tool calls, we're done
          break;
        }

        if (choice.finish_reason === 'stop') {
          break;
        }
      }
    } else {
      // Anthropic-compatible flow (uses Anthropic client with custom baseURL)
      const fallbackCap = captureVaultFallback();
      const client = new Anthropic({ 
        apiKey: VAULT_TOKEN,
        baseURL: vaultBaseURL(settings.provider),
        fetch: fallbackCap.fetch,
      });
      const anthropicTools = enableTools ? getAnthropicTools() : undefined;
      
      while (turnCount < maxTurns && !clientDisconnected) {
        turnCount++;
        activity(turnCount);

        const response = await client.messages.create({
          model: settings.model,
          max_tokens: settings.maxTokens || 32768,
          system: systemPrompt,
          messages: apiMessages,
          tools: anthropicTools,
        });
        notifyFallback(fallbackCap.notice());
        fallbackNotice = fallbackCap.notice() ?? fallbackNotice;
        // Provider cut the answer off at the Max Tokens limit.
        if (response.stop_reason === 'max_tokens') truncated = true;

        // Process response content
        let hasToolUse = false;
        const toolResults: any[] = [];

        for (const block of response.content) {
          if (block.type === 'text') {
            fullResponse += block.text;
            sendEvent({ type: 'text', content: block.text });
          } else if (block.type === 'tool_use') {
            if (clientDisconnected) break;
            hasToolUse = true;
            activity(turnCount, block.name);
            executedTools.push(block.name);

            // Send tool call info to client
            sendEvent({
              type: 'tool_call',
              tool: block.name,
              args: block.input,
              id: block.id
            });

            // Execute tool
            const result = await executeAgentTool(block.name, block.input as Record<string, unknown>);

            // Send tool result to client
            sendEvent({
              type: 'tool_result',
              tool: block.name,
              id: block.id,
              result: result.success ? result.result : { error: result.error },
              success: result.success
            });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result.success ? result.result : { error: result.error }),
            });
          }
        }
        
        // Add assistant message to conversation
        apiMessages.push({ role: 'assistant', content: response.content });
        
        // If tool was used, add results and continue
        if (hasToolUse && toolResults.length > 0) {
          apiMessages.push({ role: 'user', content: toolResults });
        } else {
          break;
        }
        
        if (response.stop_reason === 'end_turn') {
          break;
        }
      }
    }
    
    // Never-silent completion: a run whose tokens all went to tool calls (or
    // that exhausted maxTurns mid-work) must still say something — streamed
    // live as a text event and saved to the session below.
    if (fullResponse.trim() === '') {
      fullResponse = buildNeverSilentCompletion(executedTools);
      sendEvent({ type: 'text', content: fullResponse });
    } else if (truncated) {
      fullResponse += TRUNCATION_NOTE;
      sendEvent({ type: 'text', content: TRUNCATION_NOTE });
    }

    // Save final response to session
    if (fullResponse) {
      session.messages.push({
        role: 'assistant',
        content: fullResponse,
        timestamp: Date.now(),
        ...(fallbackNotice ? { fallback: fallbackNotice } : {}),
      });
    }
    session.updated = Date.now();
    await saveSession(session);

    sendEvent({
      type: 'done',
      sessionId: session.id,
      turns: turnCount,
      truncated,
    });
    res.end();
    
  } catch (error: any) {
    console.error('[Server] Stream error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// SPA catch-all - serve index.html for non-API routes
app.get('*', (req, res) => {
  // Don't catch API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// Start server
const PORT = Number(process.env.PORT) || 3001;
const MCP_WS_PORT = Number(process.env.MCP_WS_PORT) || 13011;

/**
 * Floyd Core experience sync (P5): negotiate and register as surface
 * "desktop", restore the portable model route, then keep the envelope fresh
 * for optimistic publications. An unreachable Core never blocks boot — the
 * desktop simply runs without continuity.
 */
async function startExperienceSync() {
  try {
    const token = await readGatewayToken();
    const coordinator = new DesktopExperienceCoordinator({
      baseUrl: defaultCoreBaseUrl(),
      token,
      onEnvelope: (state) => {
        latestExperienceState = state;
      },
      onError: (error) => {
        console.log('[Floyd Core] Experience sync error:', error instanceof Error ? error.message : String(error));
      },
    });
    const restored = await coordinator.start();
    experienceSync = coordinator;
    latestExperienceState = restored;

    // Apply the portable model route when it maps to a Desktop provider.
    // In-memory only: the operator's saved settings stay untouched.
    const provider = desktopProviderForRoute(restored.modelRoute.provider);
    if (provider && restored.modelRoute.model) {
      settings = { ...settings, provider, model: restored.modelRoute.model };
      delete settings.connectorId;
      broworkManager.setProvider(provider);
      broworkManager.setModel(restored.modelRoute.model);
      broworkManager.setConnector(undefined);
      console.log(`[Floyd Core] Applied portable model route: ${provider} / ${restored.modelRoute.model}`);
    }
    console.log(`[Floyd Core] Experience sync active (envelope revision ${restored.revision})`);
  } catch (error: any) {
    experienceSync = null;
    latestExperienceState = null;
    console.log(`[Floyd Core] Experience sync unavailable: ${error?.message || error} (continuing without continuity)`);
  }
}

// Publish surface presence and drain pending publications on shutdown.
async function shutdownExperienceSync() {
  const coordinator = experienceSync;
  experienceSync = null;
  if (!coordinator) return;
  await Promise.race([
    (async () => {
      await coordinator.publishPresence();
      await coordinator.stop();
    })(),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]).catch(() => {});
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdownExperienceSync().finally(() => process.exit(0));
  });
}

// Also start WebSocket MCP server for Chrome extension
initDataDir().then(async () => {
  await startExperienceSync();

  // Start Express API server — loopback only. This server exposes file,
  // shell, and code-execution tools with no authentication; it must never
  // listen on external interfaces. The frame proxies locally.
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[Floyd Web Server] Running on http://127.0.0.1:${PORT} (loopback only)`);
    console.log('[Floyd Web Server] Credential route: Vault');
  });

  // Start WebSocket MCP server for Chrome extension
  try {
    wsMcpServer = new WebSocketMCPServer(MCP_WS_PORT);
    wsMcpServer.registerTools([...BUILTIN_TOOLS]);
    await wsMcpServer.start();
    console.log(`[Floyd Web Server] WebSocket MCP server started on port ${MCP_WS_PORT} for Chrome extension`);
  } catch (error: any) {
    if (error.code === 'EADDRINUSE') {
      console.log(`[Floyd Web Server] Port ${MCP_WS_PORT} already in use - WebSocket MCP server not started`);
      console.log('[Floyd Web Server] Chrome extension will connect to existing MCP server');
    } else {
      console.error('[Floyd Web Server] Failed to start WebSocket MCP server:', error);
    }
  }
});
