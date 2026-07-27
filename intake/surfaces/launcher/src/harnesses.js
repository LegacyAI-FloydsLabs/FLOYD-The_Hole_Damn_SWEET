/**
 * harness-launcher — shared harness registry
 *
 * Single source of truth for all harness metadata.
 * Both server.js (backend validation + API) and the frontend (dynamic cards)
 * reference this file. Add a harness here; it is automatically included
 * everywhere — no duplicate arrays, no drift between frontend and backend.
 *
 * Schema per entry:
 *   name          — unique identifier, used as the shell command name
 *   description   — short human-readable blurb shown in UI cards
 *   type          — 'npm' | 'native' | 'go' | 'brew' | 'script'
 *   command       — shell command to invoke (defaults to name if omitted)
 *   args          — optional fixed args appended after the harness name
 *   configurableArgs — whether the UI should show an args input field
 *
 * ── LOCAL ROSTER (2026-07-23) ────────────────────────────────────────────
 * This localized launcher instance serves ONLY the nine purpose-built FLOYD
 * agents. Each is the FF Floyd TUI launched through a per-agent wrapper
 * (agents/bin/<slug>) that merges a deterministic prompt package, a tuned
 * sampling temperature, and a skill bundle over the canonical provider auth.
 * The interim grab-bag (pi/omp/ff/sf/crush/droid/…) is intentionally gone.
 * The canonical Floyd install and its config are never modified — each agent
 * runs in an isolated per-agent data directory under ~/.floyd-agents/<slug>.
 *
 * No authentication harness here — this is a local-only launcher.
 */

'use strict';

const path = require('path');

// Absolute path to the per-agent launcher stubs, resolved from this file so
// the roster works regardless of the launcher's working directory.
const AGENT_BIN = path.resolve(__dirname, '..', 'agents', 'bin');
const stub = (slug) => path.join(AGENT_BIN, slug);

const HARNESSES = [
  {
    name: 'code-reviewer',
    description: 'Evidence-based code review — phased severity model, refutation pass, merge decision. Temp 0.1.',
    type: 'script',
    command: stub('code-reviewer'),
    configurableArgs: true
  },
  {
    name: 'code-implementer',
    description: 'Deterministic minimal-diff implementation — locate/evidence/edit/verify, boundary-scoped. Temp 0.1.',
    type: 'script',
    command: stub('code-implementer'),
    configurableArgs: true
  },
  {
    name: 'code-planner',
    description: 'Repo-truth planning — live-evidence maps, per-step verification + rollback, resumable handoff. Temp 0.3.',
    type: 'script',
    command: stub('code-planner'),
    configurableArgs: true
  },
  {
    name: 'bug-security',
    description: 'Bug & vulnerability hunting — attack-surface enumeration, reproduce-or-refute kill-list. Temp 0.15.',
    type: 'script',
    command: stub('bug-security'),
    configurableArgs: true
  },
  {
    name: 'content-creator',
    description: 'Publication-ready writing — audience/voice matrix, fact-anchored to sources. Temp 0.7.',
    type: 'script',
    command: stub('content-creator'),
    configurableArgs: true
  },
  {
    name: 'highspeed-coder',
    description: 'HIGH SPEED bulk coding — 36x batched shell fan-out with a mandatory post-wave accuracy gate. Temp 0.2.',
    type: 'script',
    command: stub('highspeed-coder'),
    configurableArgs: true
  },
  {
    name: 'mcp-specialist',
    description: 'MCP servers/clients (HTTP & STDIO) — handshake tracing, live tool-contract validation. Temp 0.2.',
    type: 'script',
    command: stub('mcp-specialist'),
    configurableArgs: true
  },
  {
    name: 'deployment-specialist',
    description: 'Deployment — state→build→test→rollback-rehearsal→cutover→smoke→continuity gate ladder. Temp 0.1.',
    type: 'script',
    command: stub('deployment-specialist'),
    configurableArgs: true
  },
  {
    name: 'executive-board',
    description: 'Five-seat (CTO/CFO/COO/CISO/CPO) deliberation → decision memo with dissents + tripwires. Temp 0.5.',
    type: 'script',
    command: stub('executive-board'),
    configurableArgs: true
  }
];

// Derived: flat list of valid harness names (used by server validation)
const VALID_HARNESS_NAMES = HARNESSES.map((h) => h.name);

// Lookup by name — O(1) instead of array.includes
const HARNESS_BY_NAME = Object.fromEntries(HARNESSES.map((h) => [h.name, h]));

module.exports = { HARNESSES, VALID_HARNESS_NAMES, HARNESS_BY_NAME };
