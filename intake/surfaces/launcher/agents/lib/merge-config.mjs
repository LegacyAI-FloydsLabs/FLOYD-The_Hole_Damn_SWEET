#!/usr/bin/env node
/**
 * merge-config.mjs — launch-time config assembler for launcher agents.
 *
 * Usage: merge-config.mjs <base-floyd.json> <agent-overlay.json> <agent-home> <out-file>
 *
 * Deep-merges the agent overlay over the canonical Floyd data config and
 * writes the result for FLOYD_GLOBAL_DATA.
 * The string token ${AGENT_HOME} inside the overlay is replaced with the
 * agent's absolute home directory so overlays stay relocatable.
 *
 * Merge rules: objects merge recursively, arrays and scalars from the
 * overlay replace the base. Provider authentication is then replaced by the
 * launcher's persistent fv_ capability and loopback Vault routes. Missing
 * Vault profile is fatal; old copied credentials are never a fallback.
 *
 * Optional: FLOYD_AGENT_EXTRA_OVERLAY=<path> merges one more overlay last.
 * Test instrument only (e.g. smoke-testing the pipeline against an
 * alternate provider); never set it in normal launches.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  assertVaultOnlyClientConfiguration,
  buildFloydProviderConfig,
  readVaultAppProfile,
} from '../../../../../lib/vault-routing.mjs';

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

// ---- Vault-only routing --------------------------------------------------
const profilePath = process.env.FLOYD_VAULT_APP_PROFILE
  || join(RUNTIME_ROOT, 'secrets', 'proxy-app-profiles', 'launcher.json');
let profile;
try {
  profile = readVaultAppProfile(readFileSync(profilePath, 'utf8'), 'launcher');
} catch (err) {
  console.error(`merge-config: Vault application profile unavailable (${err.message}); refusing to launch`);
  process.exit(78);
}
const managedProviders = buildFloydProviderConfig(profile.token, profile.proxy);
merged.providers = {};
for (const [id, route] of Object.entries(managedProviders)) {
  merged.providers[id] = route;
}
merged.options = {
  ...(merged.options && typeof merged.options === 'object' ? merged.options : {}),
  disable_default_providers: true,
  disable_provider_auto_update: true,
};
assertVaultOnlyClientConfiguration(merged, 'launcher managed configuration');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(merged, null, 2));
chmodSync(outPath, 0o600); // merged file carries the app's fv_ capability
