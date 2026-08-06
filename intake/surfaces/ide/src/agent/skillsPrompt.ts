// ─── Installed-skills prompt injection (Phase 4, coordinates with S12–S15) ─
//
// A parallel cluster serves GET /api/skills/installed, listing skills
// materialized into agent target directories under the workspace root. Skills
// installed into the CURSEM-native `.cursem/skills` target are appended to the
// agent system prompt so they actually steer CURSEM's own runner — this is
// what makes the registry more than a file copier.
//
// Everything here is defensive by contract: a missing endpoint (404 while the
// backend lands), an unexpected payload shape, or any network failure yields
// an empty prompt block and never breaks a chat send.

const MAX_SKILL_CHARS = 8 * 1024;
const MAX_TOTAL_CHARS = 24 * 1024;

interface InstalledSkillLike {
  name?: unknown;
  slug?: unknown;
  target?: unknown;
  targetId?: unknown;
  directory?: unknown;
  content?: unknown;
  body?: unknown;
  markdown?: unknown;
}

function isCursemTarget(entry: InstalledSkillLike): boolean {
  const target = String(entry.target ?? entry.targetId ?? entry.directory ?? '');
  return target === 'cursem' || target.includes('.cursem/skills');
}

function skillBody(entry: InstalledSkillLike): string {
  const body = entry.content ?? entry.body ?? entry.markdown;
  return typeof body === 'string' ? body.trim() : '';
}

function skillName(entry: InstalledSkillLike, index: number): string {
  const name = entry.name ?? entry.slug;
  return typeof name === 'string' && name.trim() ? name.trim() : `skill-${index + 1}`;
}

/**
 * Fetch installed `.cursem/skills` bodies and format them as a system-prompt
 * block. Returns '' when the endpoint is absent, fails, or holds no CURSEM
 * skills — injection is strictly additive.
 */
export async function fetchInstalledSkillsPrompt(): Promise<string> {
  let payload: unknown;
  try {
    const response = await fetch('/api/skills/installed', { headers: { accept: 'application/json' } });
    if (!response.ok) return '';
    payload = await response.json();
  } catch {
    return '';
  }
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { skills?: unknown })?.skills)
      ? (payload as { skills: unknown[] }).skills
      : [];
  const blocks: string[] = [];
  let total = 0;
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const entry = raw as InstalledSkillLike;
    if (!isCursemTarget(entry)) return;
    const body = skillBody(entry);
    if (!body) return;
    const remaining = MAX_TOTAL_CHARS - total;
    if (remaining <= 0) return;
    const clipped = body.slice(0, Math.min(MAX_SKILL_CHARS, remaining));
    total += clipped.length;
    blocks.push(`<skill name=${JSON.stringify(skillName(entry, index))}>\n${clipped}\n</skill>`);
  });
  if (!blocks.length) return '';
  return `\n\n<installed_skills>\nThe user installed the following skills into this workspace's CURSEM agent. Follow them when relevant.\n${blocks.join('\n')}\n</installed_skills>`;
}
