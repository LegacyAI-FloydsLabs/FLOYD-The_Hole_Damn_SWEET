// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  AGENTS,
  AGENT_HOOK_SPECS,
  CURSEM_HOOK_MARKER,
  SAFE_SESSION_ID,
  agentHookFolder,
  launchCommandForAgent,
  matchAgentDef,
  mergeSharedHooksFile,
  normalizeAgentHookPayload,
  resolveAgentHookMode,
  resumeCommandForAgent,
  stripSharedHooksFile,
} from '../server/agent-hooks-spec.mjs';

const ctx = { bridgeCommand: '/hooks/cursem-hook-bridge-claude-code' };

describe('agent registry', () => {
  it('covers the six supported CLIs with resume contracts', () => {
    expect(AGENTS.map((a) => a.id)).toEqual(['claude-code', 'codex', 'cursor', 'grok', 'opencode', 'pi']);
    for (const agent of AGENTS) {
      expect(AGENT_HOOK_SPECS[agent.id]).toBeTruthy();
      expect(typeof agent.resumeArgs).toBe('function');
    }
  });

  it('matches process names case-insensitively', () => {
    expect(matchAgentDef('Claude')?.id).toBe('claude-code');
    expect(matchAgentDef('grok-4.1')?.id).toBe('grok');
    expect(matchAgentDef('cursor-agent')?.id).toBe('cursor');
    expect(matchAgentDef('node')).toBeNull();
    expect(launchCommandForAgent('opencode')).toBe('opencode');
    expect(launchCommandForAgent('unknown')).toBeNull();
  });

  it('derives auto-gate folders from the first project file', () => {
    expect(agentHookFolder('claude-code')).toBe('.claude');
    expect(agentHookFolder('codex')).toBe('.codex');
    expect(agentHookFolder('cursor')).toBe('.cursor');
    expect(agentHookFolder('grok')).toBe('.grok');
    expect(agentHookFolder('opencode')).toBe('.opencode');
    expect(agentHookFolder('pi')).toBe('.pi');
  });
});

describe('resumeCommandForAgent', () => {
  it('builds the per-CLI resume argv', () => {
    expect(resumeCommandForAgent('claude-code', 'abc-123')).toBe('claude --resume abc-123');
    expect(resumeCommandForAgent('codex', 'abc-123')).toBe('codex resume abc-123');
    expect(resumeCommandForAgent('cursor', 'abc-123')).toBe('cursor-agent --resume abc-123');
    expect(resumeCommandForAgent('grok', 'abc-123')).toBe('grok --resume abc-123');
    expect(resumeCommandForAgent('opencode', 'ses_9f')).toBe('opencode --session ses_9f');
    expect(resumeCommandForAgent('pi', 'abc-123')).toBe('pi --session abc-123');
  });

  it('refuses forged ids that would inject flags or shell syntax', () => {
    expect(resumeCommandForAgent('claude-code', '--dangerously-skip-permissions')).toBeNull();
    expect(resumeCommandForAgent('claude-code', 'abc; rm -rf /')).toBeNull();
    expect(resumeCommandForAgent('claude-code', '$(whoami)')).toBeNull();
    expect(resumeCommandForAgent('claude-code', '-x')).toBeNull();
    expect(resumeCommandForAgent('nope', 'abc')).toBeNull();
    expect(SAFE_SESSION_ID.test('0f69a3de-2f4f-4da5-8d00-9f2f4fb0f3e1')).toBe(true);
  });
});

describe('resolveAgentHookMode', () => {
  it('defaults to auto and honors sparse overrides', () => {
    expect(resolveAgentHookMode(undefined, 'codex')).toBe('auto');
    expect(resolveAgentHookMode({}, 'codex')).toBe('auto');
    expect(resolveAgentHookMode({ codex: 'on' }, 'codex')).toBe('on');
    expect(resolveAgentHookMode({ codex: 'off' }, 'codex')).toBe('off');
  });
});

describe('mergeSharedHooksFile / stripSharedHooksFile', () => {
  const events = ['SessionStart', 'Stop'];
  const group = () => ({ hooks: [{ type: 'command', command: '/x/cursem-hook-bridge-claude-code' }] });

  it('creates a fresh file when none exists', () => {
    const out = mergeSharedHooksFile(null, events, group);
    const parsed = JSON.parse(out);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain(CURSEM_HOOK_MARKER);
  });

  it('merges into a shared file without clobbering user content', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'user-hook' }] }] },
    });
    const out = mergeSharedHooksFile(existing, events, group);
    const parsed = JSON.parse(out);
    expect(parsed.permissions.allow).toEqual(['Bash(ls:*)']);
    expect(parsed.hooks.SessionStart).toHaveLength(2);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('user-hook');
  });

  it('replaces only its own stale entries on re-injection (idempotent)', () => {
    const once = mergeSharedHooksFile(null, events, group);
    expect(mergeSharedHooksFile(once, events, group)).toBeNull();
    const twice = mergeSharedHooksFile(once, events, () => ({ hooks: [{ type: 'command', command: '/y/cursem-hook-bridge-claude-code' }] }));
    const parsed = JSON.parse(twice);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('/y/cursem-hook-bridge-claude-code');
  });

  it('treats a hooks-array as empty rather than dropping named keys silently', () => {
    // The !Array.isArray guard is load-bearing: without it, named keys
    // assigned onto an array would vanish in JSON.stringify. The guard
    // replaces the array with a real object keyed by event.
    const out = mergeSharedHooksFile(JSON.stringify({ hooks: [] }), events, group);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.hooks)).toBe(false);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
  });

  it('leaves unparseable files alone', () => {
    expect(mergeSharedHooksFile('{not json', events, group)).toBeNull();
    expect(stripSharedHooksFile('{not json', events)).toBeNull();
  });

  it('strip removes our groups, preserves user entries, prunes empty events', () => {
    const existing = mergeSharedHooksFile(JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] },
    }), events, group);
    const stripped = stripSharedHooksFile(existing, events);
    const parsed = JSON.parse(stripped.content);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('user-hook');
    expect(parsed.hooks.Stop).toBeUndefined();
    expect(stripSharedHooksFile(stripped.content, events)).toBeNull();
  });
});

describe('per-agent project file builders', () => {
  it('claude merges into settings.local.json', () => {
    const spec = AGENT_HOOK_SPECS['claude-code'];
    const out = spec.projectFiles[0].build(null, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe(ctx.bridgeCommand);
    expect(spec.projectFiles[0].relPath).toBe('.claude/settings.local.json');
  });

  it('codex writes hooks.json with a timeout', () => {
    const spec = AGENT_HOOK_SPECS.codex;
    const out = spec.projectFiles[0].build(null, { bridgeCommand: '/hooks/cursem-hook-bridge-codex' });
    const parsed = JSON.parse(out);
    expect(parsed.hooks.PermissionRequest[0].hooks[0].timeout).toBe(60);
  });

  it('cursor writes the {version: 1, hooks} shape and preserves user handlers', () => {
    const spec = AGENT_HOOK_SPECS.cursor;
    const existing = JSON.stringify({ version: 1, hooks: { stop: [{ command: 'user-handler' }] } });
    const out = JSON.parse(spec.projectFiles[0].build(existing, { bridgeCommand: '/hooks/cursem-hook-bridge-cursor' }));
    expect(out.version).toBe(1);
    expect(out.hooks.stop).toEqual([{ command: 'user-handler' }, { command: '/hooks/cursem-hook-bridge-cursor' }]);
  });

  it('grok owns one file in .grok/hooks and strips by marker', () => {
    const spec = AGENT_HOOK_SPECS.grok;
    expect(spec.projectFiles[0].relPath).toBe(`.grok/hooks/${CURSEM_HOOK_MARKER}.json`);
    const out = spec.projectFiles[0].build(null, { bridgeCommand: '/hooks/cursem-hook-bridge-grok' });
    expect(spec.projectFiles[0].strip(out)).toEqual({ delete: true });
  });

  it('pi/opencode owned files are boot-independent and rewrite on drift', () => {
    for (const [agentId, relPath] of [['pi', `.pi/extensions/${CURSEM_HOOK_MARKER}.ts`], ['opencode', `.opencode/plugin/${CURSEM_HOOK_MARKER}.js`]]) {
      const spec = AGENT_HOOK_SPECS[agentId];
      expect(spec.projectFiles[0].relPath).toBe(relPath);
      const content = spec.projectFiles[0].build(null, ctx);
      expect(content).toContain(CURSEM_HOOK_MARKER);
      expect(spec.projectFiles[0].build(content, ctx)).toBeNull();
      expect(spec.projectFiles[0].strip(content)).toEqual({ delete: true });
    }
  });
});

describe('normalizeAgentHookPayload', () => {
  it('normalizes claude events including the permission notification', () => {
    const base = { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/repo', transcript_path: '/t.jsonl' };
    expect(normalizeAgentHookPayload('claude-code', 'term1', base)).toMatchObject({ kind: 'session-start', sessionId: 's1', cwd: '/repo' });
    expect(normalizeAgentHookPayload('claude-code', 'term1', { ...base, hook_event_name: 'UserPromptSubmit' }).kind).toBe('turn-start');
    expect(normalizeAgentHookPayload('claude-code', 'term1', { ...base, hook_event_name: 'PostToolUse' }).kind).toBe('turn-resume');
    expect(normalizeAgentHookPayload('claude-code', 'term1', { ...base, hook_event_name: 'Stop' }).kind).toBe('turn-end');
    expect(normalizeAgentHookPayload('claude-code', 'term1', { ...base, hook_event_name: 'SessionEnd' }).kind).toBe('session-end');
    expect(normalizeAgentHookPayload('claude-code', 'term1', { hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: 's1' }).kind).toBe('permission-wait');
    expect(normalizeAgentHookPayload('claude-code', 'term1', { hook_event_name: 'Notification', notification_type: 'idle_prompt', session_id: 's1' })).toBeNull();
  });

  it('maps codex events and drops SessionEnd (never fires, pinned live)', () => {
    expect(normalizeAgentHookPayload('codex', 't', { hook_event_name: 'PermissionRequest', session_id: 's' }).kind).toBe('permission-wait');
    expect(normalizeAgentHookPayload('codex', 't', { hook_event_name: 'SessionEnd', session_id: 's' })).toBeNull();
  });

  it('reads cursor identity from session_id/conversation_id and workspace_roots', () => {
    const event = normalizeAgentHookPayload('cursor', 't', { hook_event_name: 'sessionStart', conversation_id: 'c9', workspace_roots: ['/repo'] });
    expect(event).toMatchObject({ kind: 'session-start', sessionId: 'c9', cwd: '/repo' });
    expect(normalizeAgentHookPayload('cursor', 't', { hook_event_name: 'beforeShellExecution', session_id: 'c9' })).toBeNull();
  });

  it('handles grok split casing (file CamelCase, payload snake_case/camelCase)', () => {
    expect(normalizeAgentHookPayload('grok', 't', { hookEventName: 'user_prompt_submit', sessionId: 'g1' }).kind).toBe('turn-start');
    expect(normalizeAgentHookPayload('grok', 't', { hookEventName: 'notification', notificationType: 'permission_prompt', sessionId: 'g1' }).kind).toBe('permission-wait');
    expect(normalizeAgentHookPayload('grok', 't', { hookEventName: 'SessionStart', sessionId: 'g1' })).toBeNull();
  });

  it('maps pi and opencode in-process events', () => {
    expect(normalizeAgentHookPayload('pi', 't', { event: 'agent_start', sessionId: 'p1' }).kind).toBe('turn-start');
    expect(normalizeAgentHookPayload('pi', 't', { event: 'session_shutdown', sessionId: 'p1' }).kind).toBe('session-end');
    expect(normalizeAgentHookPayload('opencode', 't', { type: 'session.status', status: { type: 'busy' }, sessionID: 'o1' }).kind).toBe('turn-start');
    expect(normalizeAgentHookPayload('opencode', 't', { type: 'session.status', status: { type: 'idle' }, sessionID: 'o1' })).toBeNull();
    expect(normalizeAgentHookPayload('opencode', 't', { type: 'permission.replied', sessionID: 'o1' }).kind).toBe('turn-resume');
  });

  it('drops unknown agents and untracked events', () => {
    expect(normalizeAgentHookPayload('aider', 't', {})).toBeNull();
    expect(normalizeAgentHookPayload('claude-code', 't', { hook_event_name: 'PreCompact' })).toBeNull();
  });
});
