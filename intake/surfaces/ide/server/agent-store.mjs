import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;

/**
 * Durable local state for conversations, agent runs, tool evidence, proposed
 * patch transactions, and checkpoints. The database is outside the workspace
 * so CURSEM never pollutes or accidentally commits application repositories.
 * File bodies enter the database only when they are part of an explicit Agent
 * proposal/checkpoint; ordinary chat context is not mirrored automatically.
 */
export function createAgentStore({ workspaceRoot, databasePath } = {}) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw new Error('workspaceRoot is required.');
  const path = databasePath || defaultDatabasePath(workspaceRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  migrate(database);

  const statements = {
    createThread: database.prepare('INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'),
    touchThread: database.prepare('UPDATE threads SET updated_at = ? WHERE id = ?'),
    listThreads: database.prepare(`SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
      FROM threads ORDER BY updated_at DESC LIMIT ?`),
    getThread: database.prepare(`SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
      FROM threads WHERE id = ?`),
    addMessage: database.prepare(`INSERT INTO messages
      (id, thread_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
    messages: database.prepare(`SELECT id, thread_id AS threadId, role, content, metadata_json AS metadataJson,
      created_at AS createdAt FROM messages WHERE thread_id = ? ORDER BY created_at, rowid`),
    createRun: database.prepare(`INSERT INTO runs
      (id, thread_id, status, provider, model, started_at, updated_at, summary_json)
      VALUES (?, ?, 'running', ?, ?, ?, ?, '{}')`),
    updateRun: database.prepare(`UPDATE runs SET status = ?, updated_at = ?, summary_json = ? WHERE id = ?`),
    getRun: database.prepare(`SELECT id, thread_id AS threadId, status, provider, model,
      started_at AS startedAt, updated_at AS updatedAt, summary_json AS summaryJson FROM runs WHERE id = ?`),
    listRuns: database.prepare(`SELECT id, thread_id AS threadId, status, provider, model,
      started_at AS startedAt, updated_at AS updatedAt, summary_json AS summaryJson
      FROM runs WHERE thread_id = ? ORDER BY started_at DESC`),
    eventSequence: database.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_events WHERE run_id = ?'),
    appendEvent: database.prepare(`INSERT INTO run_events
      (id, run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
    events: database.prepare(`SELECT id, run_id AS runId, sequence, type, payload_json AS payloadJson,
      created_at AS createdAt FROM run_events WHERE run_id = ? ORDER BY sequence`),
    saveProposal: database.prepare(`INSERT INTO proposals
      (id, run_id, changes_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`),
    getProposal: database.prepare(`SELECT id, run_id AS runId, changes_json AS changesJson,
      created_at AS createdAt, expires_at AS expiresAt FROM proposals WHERE id = ?`),
    deleteProposal: database.prepare('DELETE FROM proposals WHERE id = ?'),
    createCheckpoint: database.prepare(`INSERT INTO checkpoints
      (id, run_id, label, files_json, created_at) VALUES (?, ?, ?, ?, ?)`),
    checkpoint: database.prepare(`SELECT id, run_id AS runId, label, files_json AS filesJson,
      created_at AS createdAt FROM checkpoints WHERE id = ?`),
    checkpoints: database.prepare(`SELECT id, run_id AS runId, label, files_json AS filesJson,
      created_at AS createdAt FROM checkpoints ORDER BY created_at DESC LIMIT ?`),
    saveMemory: database.prepare(`INSERT INTO memories (id, content, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`),
    memories: database.prepare(`SELECT id, content, source, created_at AS createdAt, updated_at AS updatedAt FROM memories ORDER BY updated_at DESC`),
    deleteMemory: database.prepare('DELETE FROM memories WHERE id = ?'),
  };

  const inTransaction = database.prepare('BEGIN IMMEDIATE');
  const commit = database.prepare('COMMIT');
  const rollback = database.prepare('ROLLBACK');
  const transaction = (operation) => {
    inTransaction.run();
    try { const result = operation(); commit.run(); return result; }
    catch (error) { rollback.run(); throw error; }
  };

  return {
    databasePath: path,
    createThread(title = 'New conversation') {
      const id = randomUUID(); const now = Date.now();
      statements.createThread.run(id, cleanTitle(title), now, now);
      return { id, title: cleanTitle(title), createdAt: now, updatedAt: now };
    },
    listThreads(limit = 100) { return statements.listThreads.all(clampLimit(limit)); },
    getThread(id) {
      const thread = statements.getThread.get(id);
      if (!thread) return null;
      return { ...thread, messages: statements.messages.all(id).map(parseMessage), runs: statements.listRuns.all(id).map(parseRun) };
    },
    addMessage(threadId, role, content, metadata = {}) {
      if (!['system', 'user', 'assistant', 'tool'].includes(role)) throw new Error('Invalid message role.');
      if (typeof content !== 'string') throw new Error('Message content must be a string.');
      const id = randomUUID(); const now = Date.now();
      transaction(() => {
        if (!statements.getThread.get(threadId)) throw new Error('Thread not found.');
        statements.addMessage.run(id, threadId, role, content, json(metadata), now);
        statements.touchThread.run(now, threadId);
      });
      return { id, threadId, role, content, metadata, createdAt: now };
    },
    createRun({ threadId, provider, model }) {
      const id = randomUUID(); const now = Date.now();
      transaction(() => {
        if (!statements.getThread.get(threadId)) throw new Error('Thread not found.');
        statements.createRun.run(id, threadId, String(provider || ''), String(model || ''), now, now);
        statements.touchThread.run(now, threadId);
      });
      return parseRun(statements.getRun.get(id));
    },
    updateRun(id, status, summary = {}) {
      if (!['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(status)) throw new Error('Invalid run status.');
      const now = Date.now();
      statements.updateRun.run(status, now, json(summary), id);
      const run = statements.getRun.get(id);
      if (!run) throw new Error('Run not found.');
      return parseRun(run);
    },
    appendEvent(runId, type, payload = {}) {
      return transaction(() => {
        if (!statements.getRun.get(runId)) throw new Error('Run not found.');
        const sequence = Number(statements.eventSequence.get(runId).sequence);
        const event = { id: randomUUID(), runId, sequence, type: String(type), payload, createdAt: Date.now() };
        statements.appendEvent.run(event.id, runId, sequence, event.type, json(payload), event.createdAt);
        return event;
      });
    },
    getRun(id) {
      const run = statements.getRun.get(id);
      return run ? { ...parseRun(run), events: statements.events.all(id).map(parseEvent) } : null;
    },
    saveProposal({ runId = null, changes, ttlMs = 30 * 60_000 }) {
      const id = randomUUID(); const now = Date.now(); const expiresAt = now + Math.max(60_000, ttlMs);
      statements.saveProposal.run(id, runId, json(changes), now, expiresAt);
      return { id, runId, changes, createdAt: now, expiresAt };
    },
    getProposal(id) {
      const row = statements.getProposal.get(id);
      if (!row) return null;
      return { ...row, changes: parseJson(row.changesJson, []) };
    },
    consumeProposal(id) { statements.deleteProposal.run(id); },
    createCheckpoint({ runId = null, label = 'Agent edit', files }) {
      const checkpoint = { id: randomUUID(), runId, label: cleanTitle(label), files, createdAt: Date.now() };
      statements.createCheckpoint.run(checkpoint.id, runId, checkpoint.label, json(files), checkpoint.createdAt);
      return checkpoint;
    },
    getCheckpoint(id) {
      const row = statements.checkpoint.get(id);
      return row ? { ...row, files: parseJson(row.filesJson, []) } : null;
    },
    listCheckpoints(limit = 100) {
      return statements.checkpoints.all(clampLimit(limit)).map((row) => ({ ...row, files: parseJson(row.filesJson, []) }));
    },
    saveMemory(content, source = 'user-approved') {
      const value = String(content || '').trim();
      if (!value) throw new Error('Memory content is required.');
      if (value.length > 4000) throw new Error('Memory content exceeds 4000 characters.');
      const memory = { id: randomUUID(), content: value, source: String(source), createdAt: Date.now(), updatedAt: Date.now() };
      statements.saveMemory.run(memory.id, memory.content, memory.source, memory.createdAt, memory.updatedAt);
      return memory;
    },
    listMemories() { return statements.memories.all(); },
    deleteMemory(id) { return statements.deleteMemory.run(id).changes > 0; },
    close() { database.close(); },
  };
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
    INSERT INTO schema_meta (version) SELECT ${SCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      status TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, summary_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(run_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      changes_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      label TEXT NOT NULL, files_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS runs_thread ON runs(thread_id, started_at);
    CREATE INDEX IF NOT EXISTS events_run ON run_events(run_id, sequence);
  `);
  const version = Number(database.prepare('SELECT version FROM schema_meta LIMIT 1').get().version);
  if (version !== SCHEMA_VERSION) throw new Error(`Unsupported CURSEM state schema ${version}.`);
}

function defaultDatabasePath(workspaceRoot) {
  const digest = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 24);
  return join(homedir(), 'Library', 'Application Support', 'CURSEM', 'workspaces', digest, 'state.sqlite');
}

function cleanTitle(value) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 160) || 'Untitled'; }
function clampLimit(value) { return Math.max(1, Math.min(500, Number(value) || 100)); }
function json(value) { return JSON.stringify(value ?? {}); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function parseMessage(row) { const { metadataJson, ...message } = row; return { ...message, metadata: parseJson(metadataJson, {}) }; }
function parseRun(row) { const { summaryJson, ...run } = row; return { ...run, summary: parseJson(summaryJson, {}) }; }
function parseEvent(row) { const { payloadJson, ...event } = row; return { ...event, payload: parseJson(payloadJson, {}) }; }
