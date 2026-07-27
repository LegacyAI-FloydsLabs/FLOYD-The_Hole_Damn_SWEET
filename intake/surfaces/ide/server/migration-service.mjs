import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SOURCES = Object.freeze({
  cursor: { label: 'Cursor', supportDirectory: 'Cursor', extensionDirectory: '.cursor/extensions' },
  vscode: { label: 'Visual Studio Code', supportDirectory: 'Code', extensionDirectory: '.vscode/extensions' },
});

/**
 * Read-only importer for existing editor profiles. It returns a strict,
 * supported CURSEM preference patch rather than raw settings, preventing API
 * keys or unrelated extension configuration from crossing into the browser.
 * The source profile is never written or renamed.
 */
export function createMigrationService(options = {}) {
  const home = options.homeDir || homedir();
  const applicationSupport = options.applicationSupport || join(home, 'Library', 'Application Support');
  return {
    async preview(sourceId) {
      const source = SOURCES[sourceId];
      if (!source) throw httpError(400, 'Migration source must be cursor or vscode.');
      const userDirectory = join(applicationSupport, source.supportDirectory, 'User');
      const settingsPath = join(userDirectory, 'settings.json');
      const keybindingsPath = join(userDirectory, 'keybindings.json');
      const snippetsDirectory = join(userDirectory, 'snippets');
      const extensionsDirectory = join(home, source.extensionDirectory);
      const settings = await readJsoncOptional(settingsPath, {});
      const keybindings = await readJsoncOptional(keybindingsPath, []);
      const snippetNames = await listNames(snippetsDirectory, (name) => name.endsWith('.json') || name.endsWith('.code-snippets'));
      const extensionNames = await listNames(extensionsDirectory, () => true);
      const extensions = deduplicateExtensions(extensionNames).map(classifyExtension);
      const preferences = mapPreferences(settings);
      return {
        source: sourceId,
        label: source.label,
        found: settings !== null || keybindings !== null || snippetNames.length > 0 || extensionNames.length > 0,
        sourcePaths: { settings: settings === null ? null : settingsPath, keybindings: keybindings === null ? null : keybindingsPath },
        preferences,
        importedKeys: Object.keys(preferences),
        keybindings: { count: Array.isArray(keybindings) ? keybindings.length : 0, status: 'unsupported', reason: 'CURSEM command remapping is not implemented; no keybinding was imported.' },
        snippets: { count: snippetNames.length, names: snippetNames, status: 'unsupported', reason: 'Snippet execution is not implemented; no snippet was imported.' },
        extensions,
      };
    },
  };
}

function mapPreferences(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  const result = {};
  assignNumber(result, 'fontSize', settings['editor.fontSize'], 11, 24);
  assignNumber(result, 'lineHeight', settings['editor.lineHeight'], 16, 36);
  assignNumber(result, 'autoSaveDelay', settings['files.autoSaveDelay'], 250, 10_000);
  assignBoolean(result, 'minimap', settings['editor.minimap.enabled']);
  assignBoolean(result, 'formatOnSave', settings['editor.formatOnSave']);
  assignBoolean(result, 'trimTrailingWhitespace', settings['files.trimTrailingWhitespace']);
  assignBoolean(result, 'insertFinalNewline', settings['files.insertFinalNewline']);
  if (typeof settings['editor.wordWrap'] === 'string') result.wordWrap = settings['editor.wordWrap'] !== 'off';
  if (typeof settings['files.autoSave'] === 'string') result.autoSave = settings['files.autoSave'] !== 'off';
  if (typeof settings['workbench.reduceMotion'] === 'string') result.reducedMotion = settings['workbench.reduceMotion'] === 'on';
  const font = mapFont(settings['editor.fontFamily']);
  if (font) result.fontFamily = font;
  return result;
}

function mapFont(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  const candidates = [
    ['jetbrains mono', 'jetbrains-mono'], ['meslo', 'meslo-nerd-font'], ['andale mono', 'andale-mono'],
    ['courier new', 'courier-new'], ['pt mono', 'pt-mono'], ['menlo', 'menlo'], ['monaco', 'monaco'],
    ['helvetica neue', 'helvetica-neue'], ['arial', 'arial'], ['courier', 'courier'],
  ];
  return candidates.find(([name]) => normalized.includes(name))?.[1] || null;
}

function classifyExtension(id) {
  const normalized = id.toLowerCase();
  const replacement = [
    [/ms-python\.python|ms-python\.vscode-pylance/, 'Built-in Pyright language service'],
    [/dbaeumer\.vscode-eslint/, 'Built-in TypeScript/JavaScript language service and task runner'],
    [/ms-vscode\.js-debug/, 'Built-in Node inspector debugger'],
    [/rust-lang\.rust-analyzer/, 'Built-in rust-analyzer bridge when installed'],
    [/redhat\.vscode-json/, 'Built-in JSON language service'],
  ].find(([pattern]) => pattern.test(normalized));
  if (replacement) return { id, classification: 'replaced', reason: replacement[1] };
  return { id, classification: 'unsupported', reason: 'CURSEM does not claim VS Code extension-host compatibility.' };
}

function deduplicateExtensions(names) {
  const ids = new Set();
  for (const name of names) {
    const match = name.match(/^(.+?)-\d+(?:\.\d+)+(?:-[^/]+)?$/);
    ids.add(match?.[1] || name);
  }
  return Array.from(ids).sort();
}

async function readJsoncOptional(path, fallback) {
  try { return JSON.parse(stripTrailingCommas(stripJsonComments(await readFile(path, 'utf8')))); }
  catch (error) { if (error?.code === 'ENOENT') return null; return fallback; }
}

async function listNames(path, include) {
  try { return (await readdir(path)).filter(include).sort(); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

function stripJsonComments(input) {
  let output = '', inString = false, escaped = false, lineComment = false, blockComment = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index], next = input[index + 1];
    if (lineComment) { if (char === '\n') { lineComment = false; output += char; } continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (!inString && char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (!inString && char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    output += char;
    if (inString && char === '\\' && !escaped) { escaped = true; continue; }
    if (char === '"' && !escaped) inString = !inString;
    escaped = false;
  }
  return output;
}

function stripTrailingCommas(input) {
  let output = '', inString = false, escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (!inString && char === ',') {
      let cursor = index + 1;
      while (/\s/.test(input[cursor] || '')) cursor += 1;
      if (input[cursor] === '}' || input[cursor] === ']') continue;
    }
    output += char;
    if (inString && char === '\\' && !escaped) { escaped = true; continue; }
    if (char === '"' && !escaped) inString = !inString;
    escaped = false;
  }
  return output;
}

function assignNumber(target, key, value, minimum, maximum) {
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = Math.max(minimum, Math.min(maximum, Math.round(value)));
}
function assignBoolean(target, key, value) { if (typeof value === 'boolean') target[key] = value; }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
