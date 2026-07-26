import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const contentScriptSource = readFileSync(
  resolve(__dirname, '../content-script.js'),
  'utf-8'
);

describe('console-capture smoke tests', () => {
  it('content-script.js loads without errors', () => {
    expect(() => {
      require('../content-script.js');
    }).not.toThrow();
  });

  it('read_console case exists in tool router', () => {
    expect(contentScriptSource).toContain("case 'read_console':");
    expect(contentScriptSource).toContain('return readConsole(args)');
  });

  it('console capture functions are defined', () => {
    expect(contentScriptSource).toContain('function _captureConsole(');
    expect(contentScriptSource).toContain('function _isFromExtension(');
    expect(contentScriptSource).toContain('function readConsole(');
    expect(contentScriptSource).toContain('const _consoleBuffer = []');
    expect(contentScriptSource).toContain('const _CONSOLE_BUFFER_MAX = 200');
    expect(contentScriptSource).toContain('const _origConsoleLog = console.log');
    expect(contentScriptSource).toContain('const _origConsoleWarn = console.warn');
    expect(contentScriptSource).toContain('const _origConsoleError = console.error');
  });
});
