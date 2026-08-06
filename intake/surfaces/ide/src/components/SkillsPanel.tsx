import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { useUIStore } from '@/store/uiStore';

interface SkillSource { repo: string; ref: string; path: string }
interface SkillEntry {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  format?: string;
  source: SkillSource;
  stars?: number;
  updatedAt?: string;
  provenance?: string;
  sourceId?: string;
  firstParty?: boolean;
}
interface SkillTarget { id: string; label: string; dir: string; injects?: boolean }
interface InstalledSkill {
  slug: string;
  name: string;
  target: string;
  path: string;
  source?: SkillSource;
  installedAt?: string;
  content?: string;
}

const SAVED_KEY = 'cursem.skills.saved.v1';
const DEFAULT_TARGET = 'cursem';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Skills request failed (HTTP ${response.status}).`);
  }
  return payload as T;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function loadSaved(): SkillEntry[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === 'string') : [];
  } catch {
    return [];
  }
}

function sourceBadge(entry: SkillEntry): string {
  if (entry.firstParty) return 'CURSEM';
  if (entry.source.repo === 'local') return 'Local';
  return 'GitHub';
}

export function SkillsPanel() {
  const addToast = useUIStore((state) => state.addToast);
  const [catalog, setCatalog] = useState<SkillEntry[]>([]);
  const [targets, setTargets] = useState<SkillTarget[]>([]);
  const [origin, setOrigin] = useState<string>('');
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [saved, setSaved] = useState<SkillEntry[]>(() => loadSaved());
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [index, current] = await Promise.all([
        api<{ skills: SkillEntry[]; targets: SkillTarget[]; origin: string }>('/api/skills/index'),
        api<{ skills: InstalledSkill[] }>('/api/skills/installed'),
      ]);
      setCatalog(index.skills);
      setTargets(index.targets);
      setOrigin(index.origin);
      setInstalled(current.skills);
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Could not load the skills catalog.', 'error');
    }
  };
  useEffect(() => { void refresh(); }, []);

  const installedKeys = useMemo(() => new Set(installed.map((skill) => `${skill.slug}:${skill.target}`)), [installed]);
  const targetLabel = useMemo(() => new Map(targets.map((target) => [target.id, target.label])), [targets]);

  const matches = (text: Array<string | undefined>) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return text.some((value) => value?.toLowerCase().includes(needle));
  };

  const filteredCatalog = catalog.filter((entry) => matches([entry.id, entry.name, entry.description, ...(entry.tags || [])]));
  const filteredInstalled = installed.filter((skill) => matches([skill.slug, skill.name, skill.target]));
  const filteredSaved = saved.filter((entry) => matches([entry.id, entry.name, entry.description, ...(entry.tags || [])]));

  const choiceFor = (key: string) => choices[key] || DEFAULT_TARGET;

  const install = async (entry: SkillEntry) => {
    const targetId = choiceFor(entry.id);
    setBusy(`install:${entry.id}`);
    try {
      await api('/api/skills/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entry, targetId }),
      });
      addToast(`Installed ${entry.name} into ${targetLabel.get(targetId) || targetId}.`, 'success');
      await refresh();
    } catch (error) {
      addToast(error instanceof Error ? error.message : `Could not install ${entry.name}.`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (skill: InstalledSkill) => {
    setBusy(`uninstall:${skill.slug}:${skill.target}`);
    try {
      await api('/api/skills/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: skill.slug, target: skill.target }),
      });
      addToast(`Uninstalled ${skill.name} from ${targetLabel.get(skill.target) || skill.target}.`, 'success');
      await refresh();
    } catch (error) {
      addToast(error instanceof Error ? error.message : `Could not uninstall ${skill.name}.`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const persistSaved = (next: SkillEntry[]) => {
    setSaved(next);
    try { window.localStorage.setItem(SAVED_KEY, JSON.stringify(next)); } catch { /* storage full or blocked */ }
  };
  const save = (entry: SkillEntry) => {
    if (saved.some((candidate) => candidate.id === entry.id)) return;
    persistSaved([...saved, entry]);
    addToast(`Saved ${entry.name} to your library.`, 'success');
  };
  const unsave = (entry: SkillEntry) => persistSaved(saved.filter((candidate) => candidate.id !== entry.id));

  const targetPicker = (key: string) => (
    <select
      aria-label="Install target"
      value={choiceFor(key)}
      onChange={(event) => setChoices((current) => ({ ...current, [key]: event.target.value }))}
    >
      {targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
    </select>
  );

  const catalogRow = (entry: SkillEntry, context: 'browse' | 'saved') => {
    const slug = slugify(entry.name || entry.id);
    const already = installedKeys.has(`${slug}:${choiceFor(entry.id)}`);
    return (
      <article className="integration-card mcp-card" key={`${context}:${entry.id}`}>
        <Icon name={entry.firstParty ? 'spark' : 'extensions'} />
        <div>
          <strong>{entry.name}</strong>
          <span>{entry.description}</span>
          <small>{sourceBadge(entry)}{entry.source.repo !== 'local' ? ` · ${entry.source.repo}` : ''}{(entry.tags || []).length ? ` · ${(entry.tags || []).join(', ')}` : ''}</small>
          <div className="mcp-actions">
            {targetPicker(entry.id)}
            <button className="button ghost" onClick={() => void install(entry)} disabled={busy === `install:${entry.id}`}>
              {busy === `install:${entry.id}` ? 'Installing…' : already ? 'Reinstall' : 'Install'}
            </button>
            {context === 'browse' && !saved.some((candidate) => candidate.id === entry.id) && (
              <button className="button ghost" onClick={() => save(entry)}>Save</button>
            )}
            {context === 'saved' && (
              <button className="button ghost" onClick={() => unsave(entry)}>Remove</button>
            )}
          </div>
        </div>
      </article>
    );
  };

  return (
    <section className="extensions-panel skills-panel" aria-label="Agent skills">
      <header className="panel-title-row"><span>AGENT SKILLS</span><small>{installed.length + filteredCatalog.length}</small></header>
      <p className="panel-caption">
        Installable SKILL.md packages. Installs write into the chosen agent target under this workspace;
        the CURSEM target is injected into the built-in agent. Catalog origin: {origin || 'loading'}.
      </p>
      <div className="mcp-actions" style={{ padding: '0 10px 8px' }}>
        <div className="input-with-icon">
          <Icon name="search" size={14} />
          <input
            aria-label="Search skills"
            placeholder="Search installed, saved, and catalog…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <header className="panel-title-row"><span>INSTALLED</span><small>{filteredInstalled.length}</small></header>
      <div className="integration-list">
        {filteredInstalled.map((skill) => (
          <article className="integration-card mcp-card" key={`${skill.slug}:${skill.target}`}>
            <Icon name="check" />
            <div>
              <strong>{skill.name}</strong>
              <span>{targetLabel.get(skill.target) || skill.target} · {skill.path}</span>
              <small>{skill.slug}</small>
              <div className="mcp-actions">
                <button className="button ghost" onClick={() => void uninstall(skill)} disabled={busy === `uninstall:${skill.slug}:${skill.target}`}>
                  {busy === `uninstall:${skill.slug}:${skill.target}` ? 'Working…' : 'Uninstall'}
                </button>
              </div>
            </div>
          </article>
        ))}
        {!filteredInstalled.length && <p className="panel-caption">No skills installed in this workspace.</p>}
      </div>

      <header className="panel-title-row"><span>SAVED</span><small>{filteredSaved.length}</small></header>
      <div className="integration-list">
        {filteredSaved.map((entry) => catalogRow(entry, 'saved'))}
        {!filteredSaved.length && <p className="panel-caption">No saved skills. Save catalog entries here for quick re-install.</p>}
      </div>

      <header className="panel-title-row"><span>BROWSE</span><small>{filteredCatalog.length}</small></header>
      <div className="integration-list">
        {filteredCatalog.map((entry) => catalogRow(entry, 'browse'))}
        {!filteredCatalog.length && <p className="panel-caption">No catalog entries match this search.</p>}
      </div>
    </section>
  );
}
