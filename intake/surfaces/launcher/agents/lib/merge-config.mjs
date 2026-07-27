#!/usr/bin/env node
/**
 * merge-config.mjs — launch-time config assembler for launcher agents.
 *
 * Usage: merge-config.mjs <base-floyd.json> <agent-overlay.json> <agent-home> <out-file>
 *
 * Deep-merges the agent overlay over the canonical Floyd data config
 * (which carries provider auth) and writes the result for FLOYD_GLOBAL_DATA.
 * The string token ${AGENT_HOME} inside the overlay is replaced with the
 * agent's absolute home directory so overlays stay relocatable.
 *
 * Merge rules: objects merge recursively, arrays and scalars from the
 * overlay replace the base. After the merge, provider API keys are
 * refreshed from the FLOYD provider-key VAULT (the frame's single source
 * of truth at /Volumes/Storage/FLOYD_RUNTIME/secrets/provider-keys.json)
 * so agents never run on stale keys copied into the base config.
 * Vault key wins over base-config key; base is untouched on disk.
 * Override the vault path with FLOYD_VAULT_PATH; disable injection
 * entirely with FLOYD_AGENT_NO_VAULT=1 (test instrument only).
 *
 * Optional: FLOYD_AGENT_EXTRA_OVERLAY=<path> merges one more overlay last.
 * Test instrument only (e.g. smoke-testing the pipeline against an
 * alternate provider); never set it in normal launches.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const [basePath, overlayPath, agentHome, outPath] = process.argv.slice(2);
if (!basePath || !overlayPath || !agentHome || !outPath) {
  console.error('usage: merge-config.mjs <base> <overlay> <agent-home> <out>');
  process.exit(64);
}

function deepMerge(base, over) {
  if (Array.isArray(base) && Array.isArray(over)) return over;
  if (base && over && typeof base === 'object' && typeof over === 'object'
      && !Array.isArray(base) && !Array.isArray(over)) {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
    return out;
  }
  return over === undefined ? base : over;
}

const substitute = (text) => text.replaceAll('${AGENT_HOME}', agentHome);

const base = JSON.parse(readFileSync(basePath, 'utf8'));
const overlay = JSON.parse(substitute(readFileSync(overlayPath, 'utf8')));
let merged = deepMerge(base, overlay);

// ---- user model selection ------------------------------------------------
// agent.json model pins are shipped defaults, not policy. A user picks their
// own models in <runtime-root>/agent-models.json:
//   { "default": { "model": ..., "provider": ... },   // all agents
//     "agents": { "<slug>": { "model": ..., ... } } }  // per-agent override
// Values deep-merge over the agent overlay's models.large, so a user can
// change just the model while keeping the agent's tuned temperature/effort.
const RUNTIME_ROOT = process.env.FLOYD_RUNTIME_ROOT || join(homedir(), '.floyd');
const MODELS_PATH = process.env.FLOYD_AGENT_MODELS_PATH || join(RUNTIME_ROOT, 'agent-models.json');
const agentSlug = agentHome.split('/').filter(Boolean).pop();
if (existsSync(MODELS_PATH)) {
  try {
    const prefs = JSON.parse(readFileSync(MODELS_PATH, 'utf8'));
    const pick = deepMerge(prefs.default ?? {}, prefs.agents?.[agentSlug] ?? {});
    if (Object.keys(pick).length) {
      merged.models ||= {};
      merged.models.large = deepMerge(merged.models.large ?? {}, pick);
    }
  } catch (err) {
    console.error(`merge-config: bad agent-models.json (${err.message}); using shipped defaults`);
  }
}

if (process.env.FLOYD_AGENT_EXTRA_OVERLAY) {
  const extra = JSON.parse(substitute(readFileSync(process.env.FLOYD_AGENT_EXTRA_OVERLAY, 'utf8')));
  merged = deepMerge(merged, extra);
}

// ---- VAULT key injection -------------------------------------------------
// The frame's provider-key vault is the single source of truth for vendor
// auth. Map vault provider ids -> floyd config provider ids and overwrite
// any stale api_key the base config carried. Missing vault or unreadable
// file degrades gracefully to base-config keys (manual operating path).
if (process.env.FLOYD_AGENT_NO_VAULT !== '1') {
  const VAULT_PATH = process.env.FLOYD_VAULT_PATH
    || join(RUNTIME_ROOT, 'secrets', 'provider-keys.json');
  // vault id -> floyd provider ids that share the same credential.
  // ids: native provider ids for this vendor (inject unless repointed away).
  // takeover: ids injected ONLY when their base_url is on this vendor's host
  // (e.g. the base config's "anthropic" entry proxied to api.minimax.io).
  const VAULT_MAP = {
    zai:       { ids: ['zai', 'zhipu-coding', 'zhipu'], host: /z\.ai|bigmodel\.cn/ },
    minimax:   { ids: ['minimax', 'minimax-china'], takeover: ['anthropic'], host: /minimax/ },
    moonshot:  { ids: ['moonshot'], host: /moonshot/ },
    anthropic: { ids: ['anthropic'], host: /anthropic\.com/ },
    openai:    { ids: ['openai'], host: /openai\.com/ },
    google:    { ids: ['gemini'], host: /googleapis\.com/ },
    mistral:   { ids: ['codestral', 'mistral'], host: /mistral\.ai/ },
    deepseek:  { ids: ['deepseek'], host: /deepseek/ },
    openrouter:{ ids: ['openrouter'], host: /openrouter/ },
    huggingface:{ ids: ['huggingface'], host: /huggingface/ },
    xai:       { ids: ['xai'], host: /x\.ai/ },
    groq:      { ids: ['groq'], host: /groq/ },
  };
  try {
    const vault = JSON.parse(readFileSync(VAULT_PATH, 'utf8'));
    merged.providers ||= {};
    for (const [vaultId, { ids, takeover = [], host }] of Object.entries(VAULT_MAP)) {
      const key = vault[vaultId]?.key;
      if (!key) continue;
      for (const fid of ids) {
        const existing = merged.providers[fid];
        // Respect repointed providers: a base_url on another vendor's host
        // keeps its own credential (a takeover rule may claim it instead).
        if (existing?.base_url && !host.test(existing.base_url)) continue;
        if (existing) existing.api_key = key;
        else merged.providers[fid] = { api_key: key };
      }
      for (const fid of takeover) {
        const existing = merged.providers[fid];
        if (existing?.base_url && host.test(existing.base_url)) existing.api_key = key;
      }
    }
  } catch (err) {
    console.error(`merge-config: vault unavailable (${err.message}); using base-config keys`);
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(merged, null, 2));
chmodSync(outPath, 0o600); // merged file carries provider credentials
