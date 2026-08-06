import { describe, expect, it } from 'vitest';
import { buildNeverSilentCompletion, summarizeToolActions, TRUNCATION_NOTE } from './completion-guard.js';

describe('summarizeToolActions', () => {
  it('lists each tool once in first-use order with repeat counts', () => {
    expect(summarizeToolActions(['read_file', 'list_directory', 'read_file', 'read_file', 'execute_command']))
      .toBe('read_file ×3, list_directory, execute_command');
  });

  it('handles empty and single-tool input', () => {
    expect(summarizeToolActions([])).toBe('');
    expect(summarizeToolActions(['read_file'])).toBe('read_file');
  });
});

describe('buildNeverSilentCompletion', () => {
  it('names the tool work done when tools ran', () => {
    expect(buildNeverSilentCompletion(['list_directory', 'read_file', 'read_file']))
      .toBe('Done — I ran 3 tool actions (list_directory, read_file ×2) but produced no written summary. Ask me to summarize what I found.');
  });

  it('uses the singular form for one tool action', () => {
    expect(buildNeverSilentCompletion(['execute_command']))
      .toBe('Done — I ran 1 tool action (execute_command) but produced no written summary. Ask me to summarize what I found.');
  });

  it('still answers when nothing ran at all', () => {
    const message = buildNeverSilentCompletion([]);
    expect(message).toContain('no written summary');
    expect(message).not.toContain('tool action');
  });
});

describe('TRUNCATION_NOTE', () => {
  it('points the user at the Max Tokens setting and the continue escape hatch', () => {
    expect(TRUNCATION_NOTE).toContain('Max Tokens');
    expect(TRUNCATION_NOTE).toContain('continue');
  });
});
