import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative } from 'node:path';

const MAX_CHANGES = 128;
const MAX_TRANSACTION_BYTES = 32 * 1024 * 1024;

/**
 * Server-owned patch transactions. Preview freezes the proposed contents and
 * current hashes in SQLite. Apply accepts only the proposal id plus reviewed
 * paths; it then rechecks every hash before touching disk. Writes are prepared
 * beside their targets and existing files are renamed to backups, allowing a
 * failed transaction to roll back without exposing a partially written file.
 */
export function createPatchTransactions({ boundary, store }) {
  if (!boundary || !store) throw new Error('boundary and store are required.');

  async function preview(input) {
    const changes = await normalizeChanges(input?.changes, boundary);
    const proposal = store.saveProposal({ runId: input?.runId || null, changes });
    return {
      proposalId: proposal.id,
      expiresAt: proposal.expiresAt,
      files: changes.map(publicChange),
    };
  }

  async function apply(input) {
    const proposal = requiredProposal(store, input?.proposalId);
    const selected = selectChanges(proposal.changes, input?.acceptedPaths, input?.acceptedHunks);
    await assertUnchanged(selected, boundary);
    const checkpointFiles = selected.map((change) => ({
      path: change.path,
      before: change.before,
      after: change.after,
      beforeHash: change.beforeHash,
      afterHash: hash(change.after),
      mode: change.mode,
    }));
    await applyAtomically(selected, boundary);
    const checkpoint = store.createCheckpoint({
      runId: proposal.runId,
      label: input?.label || `Agent edit: ${selected.length} file${selected.length === 1 ? '' : 's'}`,
      files: checkpointFiles,
    });
    store.consumeProposal(proposal.id);
    return { checkpointId: checkpoint.id, files: checkpointFiles.map(({ before, after, ...file }) => file) };
  }

  async function restore(input) {
    const checkpoint = store.getCheckpoint(input?.checkpointId);
    if (!checkpoint) throw httpError(404, 'Checkpoint not found.');
    const inverse = checkpoint.files.map((file) => ({
      path: file.path,
      before: file.after,
      after: file.before,
      beforeHash: file.afterHash,
      mode: file.mode,
      operation: file.before === null ? 'delete' : file.after === null ? 'create' : 'modify',
    }));
    await assertUnchanged(inverse, boundary);
    await applyAtomically(inverse, boundary);
    return { restored: checkpoint.id, files: inverse.map(publicChange) };
  }

  return { preview, apply, restore };
}

async function normalizeChanges(changes, boundary) {
  if (!Array.isArray(changes) || changes.length === 0) throw httpError(400, 'A non-empty changes array is required.');
  if (changes.length > MAX_CHANGES) throw httpError(413, `A transaction may change at most ${MAX_CHANGES} files.`);
  const paths = new Set(); let bytes = 0; const normalized = [];
  for (const raw of changes) {
    if (!raw || typeof raw.path !== 'string' || !raw.path.trim()) throw httpError(400, 'Every change requires a path.');
    if (raw.content !== null && typeof raw.content !== 'string') throw httpError(400, 'Change content must be a string or null for deletion.');
    const candidate = boundary.candidate(raw.path);
    const path = relative(boundary.root, candidate);
    if (!path || path.startsWith('..')) throw httpError(400, 'The workspace root cannot be changed.');
    if (paths.has(path)) throw httpError(400, `Duplicate change path: ${path}`);
    paths.add(path);
    let before = null; let mode = null;
    try {
      const target = await boundary.existing(path);
      const metadata = await stat(target);
      if (!metadata.isFile()) throw httpError(400, `${path} is not a regular file.`);
      before = await readFile(target, 'utf8'); mode = metadata.mode;
    } catch (error) {
      // boundary.existing() reports a missing target as HttpError(404); a raw
      // ENOENT can still race in from stat/readFile. Both mean "create".
      if (error?.status === 404 || error?.code === 'ENOENT') {
        await boundary.writableTree(path);
      } else {
        throw error;
      }
    }
    if (before === null && raw.content === null) throw httpError(400, `Cannot delete missing file: ${path}`);
    bytes += Buffer.byteLength(before || '') + Buffer.byteLength(raw.content || '');
    if (bytes > MAX_TRANSACTION_BYTES) throw httpError(413, `Transaction exceeds ${MAX_TRANSACTION_BYTES} bytes.`);
    normalized.push({
      path,
      before,
      after: raw.content,
      beforeHash: hash(before),
      mode,
      operation: before === null ? 'create' : raw.content === null ? 'delete' : 'modify',
      stats: diffStats(before, raw.content),
      hunks: computeHunks(before, raw.content),
    });
  }
  return normalized;
}

async function assertUnchanged(changes, boundary) {
  for (const change of changes) {
    let current = null;
    try { current = await readFile(await boundary.existing(change.path), 'utf8'); }
    catch (error) { if (error?.code !== 'ENOENT' && error?.status !== 404) throw error; }
    if (hash(current) !== change.beforeHash) throw httpError(409, `${change.path} changed after the proposal was created.`);
  }
}

async function applyAtomically(changes, boundary) {
  const prepared = [];
  try {
    for (const change of changes) {
      const target = boundary.candidate(change.path);
      await mkdir(dirname(target), { recursive: true });
      const suffix = `.cursem-${randomUUID()}`;
      const temp = `${target}${suffix}.tmp`; const backup = `${target}${suffix}.bak`;
      if (change.after !== null) {
        await writeFile(temp, change.after, { encoding: 'utf8', mode: change.mode || 0o600, flag: 'wx' });
        if (change.mode) await chmod(temp, change.mode);
      }
      prepared.push({ ...change, target, temp, backup, backedUp: false, installed: false });
    }
    for (const item of prepared) {
      if (item.before !== null) { await rename(item.target, item.backup); item.backedUp = true; }
      if (item.after !== null) { await rename(item.temp, item.target); item.installed = true; }
    }
    await Promise.all(prepared.filter((item) => item.backedUp).map((item) => rm(item.backup, { force: true })));
  } catch (error) {
    for (const item of [...prepared].reverse()) {
      if (item.installed) await rm(item.target, { force: true }).catch(() => undefined);
      if (item.backedUp) await rename(item.backup, item.target).catch(() => undefined);
      await rm(item.temp, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await Promise.all(prepared.map((item) => rm(item.temp, { force: true }).catch(() => undefined)));
  }
}

function requiredProposal(store, id) {
  if (typeof id !== 'string' || !id) throw httpError(400, 'proposalId is required.');
  const proposal = store.getProposal(id);
  if (!proposal) throw httpError(404, 'Proposal not found.');
  if (proposal.expiresAt < Date.now()) { store.consumeProposal(id); throw httpError(410, 'Proposal expired.'); }
  return proposal;
}

function selectChanges(changes, acceptedPaths, acceptedHunks) {
  if (acceptedPaths === undefined && acceptedHunks === undefined) return changes;
  if (!Array.isArray(acceptedPaths) || acceptedPaths.some((path) => typeof path !== 'string')) throw httpError(400, 'acceptedPaths must be an array of strings.');
  const accepted = new Set(acceptedPaths); const selected = changes.filter((change) => accepted.has(change.path));
  if (!selected.length) throw httpError(400, 'Select at least one proposed file.');
  if (selected.length !== accepted.size) throw httpError(400, 'acceptedPaths contains an unknown path.');
  if (acceptedHunks === undefined) return selected;
  if (!acceptedHunks || typeof acceptedHunks !== 'object' || Array.isArray(acceptedHunks)) throw httpError(400, 'acceptedHunks must be an object keyed by path.');
  const withHunks = selected.flatMap((change) => {
    const ids = acceptedHunks[change.path];
    if (ids === undefined) return [change];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw httpError(400, `acceptedHunks for ${change.path} must be an array of ids.`);
    const known = new Set(change.hunks.map((hunk) => hunk.id));
    if (ids.some((id) => !known.has(id))) throw httpError(400, `acceptedHunks contains an unknown hunk for ${change.path}.`);
    if (!ids.length) return [];
    if (ids.length === change.hunks.length) return [change];
    if (change.operation !== 'modify') throw httpError(400, `Create/delete changes must be accepted as a whole file: ${change.path}`);
    const after = applySelectedHunks(change.before, change.hunks, new Set(ids));
    return [{ ...change, after, operation: 'modify', stats: diffStats(change.before, after), hunks: change.hunks.filter((hunk) => ids.includes(hunk.id)) }];
  });
  if (!withHunks.length) throw httpError(400, 'Select at least one proposed hunk.');
  return withHunks;
}

function publicChange(change) {
  return { path: change.path, operation: change.operation, beforeHash: change.beforeHash, afterHash: hash(change.after), stats: change.stats || diffStats(change.before, change.after), hunks: change.hunks || computeHunks(change.before, change.after) };
}
function hash(value) { return value === null ? null : createHash('sha256').update(value).digest('hex'); }
function diffStats(before, after) {
  const oldLines = before === null ? 0 : before.split('\n').length;
  const newLines = after === null ? 0 : after.split('\n').length;
  return { oldLines, newLines, delta: newLines - oldLines };
}

function computeHunks(before, after) {
  const oldLines = before === null ? [] : before.split('\n');
  const newLines = after === null ? [] : after.split('\n');
  if (before === null || after === null || oldLines.length * newLines.length > 500_000) {
    return [{ id: 'hunk-1', oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length, beforeLines: oldLines, afterLines: newLines }];
  }
  const rows = oldLines.length + 1; const cols = newLines.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let old = oldLines.length - 1; old >= 0; old -= 1) {
    for (let next = newLines.length - 1; next >= 0; next -= 1) {
      table[old][next] = oldLines[old] === newLines[next] ? table[old + 1][next + 1] + 1 : Math.max(table[old + 1][next], table[old][next + 1]);
    }
  }
  const ops = []; let old = 0; let next = 0;
  while (old < oldLines.length || next < newLines.length) {
    if (old < oldLines.length && next < newLines.length && oldLines[old] === newLines[next]) {
      ops.push({ type: 'equal', line: oldLines[old] }); old += 1; next += 1;
    } else if (next < newLines.length && (old === oldLines.length || table[old][next + 1] >= table[old + 1][next])) {
      ops.push({ type: 'add', line: newLines[next] }); next += 1;
    } else { ops.push({ type: 'remove', line: oldLines[old] }); old += 1; }
  }
  const hunks = []; let oldLine = 1; let newLine = 1; let pending = null;
  const flush = () => {
    if (!pending) return;
    hunks.push({ id: `hunk-${hunks.length + 1}`, ...pending }); pending = null;
  };
  for (const op of ops) {
    if (op.type === 'equal') { flush(); oldLine += 1; newLine += 1; continue; }
    if (!pending) pending = { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0, beforeLines: [], afterLines: [] };
    if (op.type === 'remove') { pending.oldLines += 1; pending.beforeLines.push(op.line); oldLine += 1; }
    else { pending.newLines += 1; pending.afterLines.push(op.line); newLine += 1; }
  }
  flush();
  return hunks;
}

function applySelectedHunks(before, hunks, selected) {
  const lines = before.split('\n');
  for (const hunk of [...hunks].reverse()) {
    if (!selected.has(hunk.id)) continue;
    lines.splice(hunk.oldStart - 1, hunk.oldLines, ...hunk.afterLines);
  }
  return lines.join('\n');
}
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
