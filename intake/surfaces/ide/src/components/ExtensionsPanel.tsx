import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { usePlatform, type McpServerInfo, type McpTool, type MigrationPreview } from '@/platform';
import { useUIStore } from '@/store/uiStore';
import type { EditorPreferences } from '@/store/uiStore';

const integrations: Array<{ name: string; detail: string; icon: IconName; mode: string }> = [
  { name: 'Monaco Editor', detail: 'Syntax, diagnostics, formatting, diff', icon: 'files', mode: 'Built in' },
  { name: 'Model routing', detail: 'OpenCode Go, Zen, OpenAI, and Anthropic through the loopback relay', icon: 'spark', mode: 'Built in' },
  { name: 'TerminalOne', detail: 'Authenticated loopback workspace terminal sessions', icon: 'terminal', mode: 'Local service' },
  { name: 'Language Services', detail: 'Monaco language intelligence with external LSP contracts', icon: 'command', mode: 'Built in' },
  { name: 'System Git', detail: 'Status, stage, commit, pull, and push', icon: 'source', mode: 'Local service' },
  { name: 'Debug Adapters', detail: 'Launch, step, variables, and stack contracts', icon: 'debug', mode: 'Adapter ready' },
];

export function ExtensionsPanel() {
  const { gateway } = usePlatform();
  const addToast = useUIStore((state) => state.addToast);
  const updatePreferences = useUIStore((state) => state.updatePreferences);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [tools, setTools] = useState<Record<string, McpTool[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [migration, setMigration] = useState<MigrationPreview | null>(null);
  const [migrationSource, setMigrationSource] = useState<'cursor' | 'vscode'>('cursor');

  const refresh = () => gateway.mcpListServers().then(setServers).catch((error) => addToast(error instanceof Error ? error.message : 'Could not load MCP configuration.', 'error'));
  useEffect(() => { void refresh(); }, [gateway]);

  const toggleServer = async (server: McpServerInfo) => {
    setBusy(server.id);
    try {
      if (server.status === 'connected') {
        await gateway.mcpDisconnect(server.id); setTools((current) => { const next = { ...current }; delete next[server.id]; return next; });
      } else {
        await gateway.mcpConnect(server.id);
        setTools((current) => ({ ...current, [server.id]: [] }));
      }
      await refresh();
    } catch (error) { addToast(error instanceof Error ? error.message : `MCP ${server.id} failed.`, 'error'); }
    finally { setBusy(null); }
  };

  const inspectTools = async (id: string) => {
    try { const available = await gateway.mcpListTools(id); setTools((current) => ({ ...current, [id]: available })); }
    catch (error) { addToast(error instanceof Error ? error.message : `Could not list ${id} tools.`, 'error'); }
  };

  const previewMigration = async () => {
    setBusy('migration');
    try { setMigration(await gateway.migrationPreview(migrationSource)); }
    catch (error) { addToast(error instanceof Error ? error.message : 'Could not inspect the editor profile.', 'error'); }
    finally { setBusy(null); }
  };

  const applyMigration = () => {
    if (!migration?.importedKeys.length) return;
    updatePreferences(migration.preferences as Partial<EditorPreferences>);
    addToast(`Applied ${migration.importedKeys.length} compatible ${migration.label} setting${migration.importedKeys.length === 1 ? '' : 's'}. Source profile unchanged.`, 'success');
  };

  return (
    <section className="extensions-panel" aria-label="IDE integrations">
      <header className="panel-title-row"><span>INTEGRATIONS & MCP</span><small>{integrations.length + servers.length + 1}</small></header>
      <p className="panel-caption">Built-ins and explicitly activated MCP servers. CURSEM never installs or starts an MCP server merely by displaying this list.</p>
      <article className="integration-card migration-card">
        <Icon name="upload" />
        <div><strong>Cursor / VS Code migration</strong><span>Read-only profile inspection with explicit compatibility reporting</span><small>No source files or extensions are modified</small>
          <div className="mcp-actions"><select aria-label="Migration source" value={migrationSource} onChange={(event) => { setMigrationSource(event.target.value as 'cursor' | 'vscode'); setMigration(null); }}><option value="cursor">Cursor</option><option value="vscode">Visual Studio Code</option></select><button className="button ghost" onClick={() => void previewMigration()} disabled={busy === 'migration'}>{busy === 'migration' ? 'Inspecting…' : 'Preview import'}</button></div>
          {migration && <div className="migration-report">
            <span><strong>{migration.found ? migration.label : `No ${migration.label} profile found`}</strong></span>
            <span>{migration.importedKeys.length} compatible settings: {migration.importedKeys.join(', ') || 'none'}</span>
            <span>{migration.keybindings.count} keybindings · not imported</span>
            <span>{migration.snippets.count} snippets · not imported</span>
            <span>{migration.extensions.filter((extension) => extension.classification === 'replaced').length} extensions replaced by built-ins · {migration.extensions.filter((extension) => extension.classification === 'unsupported').length} unsupported</span>
            {migration.extensions.slice(0, 20).map((extension) => <span className="mcp-tool" key={extension.id}><strong>{extension.id}</strong> — {extension.classification}: {extension.reason}</span>)}
            <button className="button primary" onClick={applyMigration} disabled={!migration.importedKeys.length}>Apply compatible settings</button>
          </div>}
        </div>
      </article>
      <div className="integration-list">
        {integrations.map((integration) => (
          <article className="integration-card" key={integration.name}>
            <Icon name={integration.icon} />
            <div><strong>{integration.name}</strong><span>{integration.detail}</span><small>{integration.mode}</small></div>
          </article>
        ))}
        {servers.map((server) => <article className="integration-card mcp-card" key={server.id}>
          <Icon name="command" />
          <div><strong>{server.id}</strong><span>{server.transport} · {server.scope} · {server.status}</span><small>{server.envKeys.length ? `env: ${server.envKeys.join(', ')}` : 'no declared env'}</small>
            <div className="mcp-actions"><button className="button ghost" onClick={() => void toggleServer(server)} disabled={busy === server.id}>{busy === server.id ? 'Working…' : server.status === 'connected' ? 'Disconnect' : 'Connect'}</button>{server.status === 'connected' && <button className="button ghost" onClick={() => void inspectTools(server.id)}>Inspect tools</button>}</div>
            {tools[server.id]?.map((tool) => <span className="mcp-tool" key={tool.name}><strong>{tool.name}</strong>{tool.description && ` — ${tool.description}`}</span>)}
          </div>
        </article>)}
        {!servers.length && <p className="panel-caption">No MCP servers configured. Add `.cursem/mcp.json` or reuse `.cursor/mcp.json`.</p>}
      </div>
    </section>
  );
}
