// @vitest-environment node
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStandaloneHost } from '../server/standalone-host.mjs';

const cleanups = [];
const ENV_KEYS = ['CURSEM_SKILLS_SOURCE_ROOT', 'CURSEM_SKILLS_SEED_DIR', 'CURSEM_SKILLS_INDEX_URL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const SEED_SKILL_MD = `---
name: seed-skill
description: Bundled seed skill for tests.
---

# Seed Skill

Seed body.
`;

const LOCAL_SKILL_MD = `---
name: wrong-name
description: Local fixture skill.
---

# Local Skill

Local body.
`;

async function makeSourceTree() {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'cursem-skills-src-'));
  const seedDir = await mkdtemp(join(tmpdir(), 'cursem-skills-seed-'));
  await mkdir(join(sourceRoot, '.agents/skills/local-skill'), { recursive: true });
  await writeFile(join(sourceRoot, '.agents/skills/local-skill/SKILL.md'), LOCAL_SKILL_MD);
  await mkdir(join(seedDir, 'seed-skill'), { recursive: true });
  await writeFile(join(seedDir, 'seed-skill/SKILL.md'), SEED_SKILL_MD);
  await writeFile(join(seedDir, 'skills-index.json'), JSON.stringify({
    version: 1,
    skills: [
      {
        id: 'seed-skill', name: 'seed-skill', description: 'Bundled seed.', tags: ['seed'], format: 'skill-md',
        source: { repo: 'local', ref: '', path: 'seed-skills/seed-skill' },
        provenance: 'bundled', sourceId: 'cursem-seed', firstParty: true,
      },
      {
        id: 'local-skill', name: 'Local Skill', description: 'Local fixture.', tags: ['test'], format: 'skill-md',
        source: { repo: 'local', ref: '', path: '.agents/skills/local-skill' },
        provenance: 'local', sourceId: 'local-repo',
      },
    ],
  }));
  cleanups.push(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(seedDir, { recursive: true, force: true });
  });
  return { sourceRoot, seedDir };
}

async function fixture(shared = {}) {
  const root = shared.root || await mkdtemp(join(tmpdir(), 'cursem-skills-ws-'));
  const { sourceRoot, seedDir } = shared.source || await makeSourceTree();
  process.env.CURSEM_SKILLS_SOURCE_ROOT = sourceRoot;
  process.env.CURSEM_SKILLS_SEED_DIR = seedDir;
  // Unreachable loopback index URL forces the remote-fetch failure path and
  // the bundled-seed fallback, without any real network access.
  process.env.CURSEM_SKILLS_INDEX_URL = 'http://127.0.0.1:1/skills-index.json';
  const host = await createStandaloneHost({ initialWorkspaceRoot: root });
  const server = http.createServer((req, res) => { void host.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(async () => {
    host.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (!shared.root) await rm(root, { recursive: true, force: true });
    if (!shared.source) { /* source tree cleanup registered in makeSourceTree */ }
  });
  return { root, base, sourceRoot, seedDir };
}

const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const LOCAL_ENTRY = {
  id: 'local-skill', name: 'Local Skill', description: 'Local fixture.', tags: ['test'], format: 'skill-md',
  source: { repo: 'local', ref: '', path: '.agents/skills/local-skill' },
  provenance: 'local', sourceId: 'local-repo',
};

describe('skills registry', () => {
  it('serves the seed catalog with targets and falls back when the remote index fails', async () => {
    const { base } = await fixture();
    const response = await fetch(`${base}/api/skills/index`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.origin).toBe('seed');
    expect(payload.skills.map((skill) => skill.id)).toEqual(expect.arrayContaining(['seed-skill', 'local-skill']));
    const targetIds = payload.targets.map((target) => target.id);
    expect(targetIds).toEqual(expect.arrayContaining(['cursem', 'claude-code', 'codex', 'cursor', 'grok', 'opencode', 'pi-native']));
    expect(payload.targets.find((target) => target.id === 'cursem').dir).toBe('.cursem/skills');
  });

  it('auto-seeds the first-party skill, preserves user edits, and remembers uninstalls', async () => {
    const { root, base } = await fixture();
    const seededPath = join(root, '.cursem/skills/seed-skill/SKILL.md');
    expect(existsSync(seededPath)).toBe(true);
    expect(await readFile(seededPath, 'utf8')).toContain('# Seed Skill');

    // A user edit survives a workspace reopen (a second host over the same root).
    await writeFile(seededPath, 'user edited content\n');
    const second = await fixture({ root, source: { sourceRoot: join(root, '.unused-src'), seedDir: process.env.CURSEM_SKILLS_SEED_DIR } });
    expect(await readFile(seededPath, 'utf8')).toBe('user edited content\n');
    expect(second.base).toBeTruthy();

    // Explicit uninstall is remembered: a third host does not re-seed.
    const uninstall = await post(base, '/api/skills/uninstall', { slug: 'seed-skill', target: 'cursem' });
    expect(uninstall.status).toBe(200);
    expect(existsSync(join(root, '.cursem/skills/seed-skill'))).toBe(false);
    await fixture({ root, source: { sourceRoot: process.env.CURSEM_SKILLS_SOURCE_ROOT, seedDir: process.env.CURSEM_SKILLS_SEED_DIR } });
    expect(existsSync(seededPath)).toBe(false);
    const ledger = JSON.parse(await readFile(join(root, '.cursem/skills.json'), 'utf8'));
    expect(ledger.uninstalledSeeds).toContain('seed-skill');
    await rm(root, { recursive: true, force: true });
  });

  it('installs a local skill with forced name frontmatter and serves cursem content', async () => {
    const { root, base } = await fixture();
    const install = await post(base, '/api/skills/install', { entry: LOCAL_ENTRY, targetId: 'cursem' });
    expect(install.status).toBe(200);
    const result = await install.json();
    expect(result.slug).toBe('local-skill');
    const onDisk = await readFile(join(root, '.cursem/skills/local-skill/SKILL.md'), 'utf8');
    expect(onDisk).toContain('name: local-skill');
    expect(onDisk).not.toContain('name: wrong-name');

    const installed = await fetch(`${base}/api/skills/installed`).then((response) => response.json());
    const record = installed.skills.find((skill) => skill.slug === 'local-skill' && skill.target === 'cursem');
    expect(record).toBeTruthy();
    expect(record.content).toContain('# Local Skill');

    const ledger = JSON.parse(await readFile(join(root, '.cursem/skills.json'), 'utf8'));
    expect(ledger.installed.some((entry) => entry.slug === 'local-skill' && entry.target === 'cursem')).toBe(true);
  });

  it('installs into a non-cursem target directory convention', async () => {
    const { root, base } = await fixture();
    const install = await post(base, '/api/skills/install', { entry: LOCAL_ENTRY, targetId: 'pi-native' });
    expect(install.status).toBe(200);
    expect(existsSync(join(root, '.agents/skills/local-skill/SKILL.md'))).toBe(true);
  });

  it('rejects unknown targets, bad slugs, and source path escapes', async () => {
    const { base } = await fixture();
    const badTarget = await post(base, '/api/skills/install', { entry: LOCAL_ENTRY, targetId: '../../etc' });
    expect(badTarget.status).toBe(400);
    const escapeEntry = { ...LOCAL_ENTRY, source: { repo: 'local', ref: '', path: '../outside' } };
    const escape = await post(base, '/api/skills/install', { entry: escapeEntry, targetId: 'cursem' });
    expect([400, 403]).toContain(escape.status);
    const badSlug = await post(base, '/api/skills/uninstall', { slug: '../..', target: 'cursem' });
    expect(badSlug.status).toBe(400);
  });

  it('uninstalls a skill and updates the ledger', async () => {
    const { root, base } = await fixture();
    await post(base, '/api/skills/install', { entry: LOCAL_ENTRY, targetId: 'cursor' });
    expect(existsSync(join(root, '.cursor/skills/local-skill/SKILL.md'))).toBe(true);
    const uninstall = await post(base, '/api/skills/uninstall', { slug: 'local-skill', target: 'cursor' });
    expect(uninstall.status).toBe(200);
    expect(existsSync(join(root, '.cursor/skills/local-skill'))).toBe(false);
    const installed = await fetch(`${base}/api/skills/installed`).then((response) => response.json());
    expect(installed.skills.some((skill) => skill.slug === 'local-skill')).toBe(false);
  });
});
