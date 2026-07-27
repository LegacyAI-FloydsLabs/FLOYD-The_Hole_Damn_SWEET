import type { ContrastFailure, ResolvedTheme, ResolvedToken, ThemeDefinition, ValidationReport } from './types';

const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\([^)]+\))$/i;
const MAX_REFERENCE_DEPTH = 10;

const contrastTargets = [
  { token: 'fg.primary', against: 'bg.editor', minimum: 4.5 },
  { token: 'fg.secondary', against: 'bg.editor', minimum: 3 },
  { token: 'accent.primary', against: 'bg.editor', minimum: 3 },
  { token: 'semantic.error', against: 'bg.editor', minimum: 3 },
] as const;

function parseHex(value: string): [number, number, number] | null {
  if (!value.startsWith('#')) return null;
  const source = value.slice(1);
  const normalized = source.length === 3 ? source.split('').map((part) => `${part}${part}`).join('') : source.slice(0, 6);
  if (normalized.length !== 6) return null;
  const number = Number.parseInt(normalized, 16);
  if (!Number.isFinite(number)) return null;
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function luminance(value: string): number | null {
  const rgb = parseHex(value);
  if (!rgb) return null;
  const channels = rgb.map((channel) => {
    const linear = channel / 255;
    return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function checkContrast(foreground: string, background: string): number | null {
  const a = luminance(foreground);
  const b = luminance(background);
  if (a === null || b === null) return null;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export class ThemeEngine {
  private definition: ThemeDefinition | null = null;
  private resolved = new Map<string, string>();

  load(definition: ThemeDefinition): ValidationReport {
    this.definition = definition;
    this.resolved.clear();
    return this.validate();
  }

  getToken(name: string): ResolvedToken | null {
    if (!this.definition) return null;
    try {
      const value = this.resolve(name, new Set(), 0);
      return { value, contrastPass: true };
    } catch {
      return null;
    }
  }

  toFlatConfig(): Record<string, string> {
    if (!this.definition) return {};
    const config: Record<string, string> = {};
    for (const name of Object.keys(this.definition.semanticTokens)) {
      const token = this.getToken(name);
      if (token) config[name] = token.value;
    }
    return config;
  }

  resolveTheme(report = this.validate()): ResolvedTheme {
    if (!this.definition) throw new Error('No theme is loaded.');
    return { definition: this.definition, tokens: this.toFlatConfig(), report };
  }

  validate(): ValidationReport {
    if (!this.definition) return { valid: false, errors: ['No theme is loaded.'], warnings: [], contrastFailures: [] };
    const errors: string[] = [];
    const warnings: string[] = [];
    const contrastFailures: ContrastFailure[] = [];

    if (!this.definition.id.trim() || !this.definition.name.trim()) errors.push('Theme id and name are required.');
    if (Object.keys(this.definition.palette).length > 1000) warnings.push('Theme palette exceeds 1000 entries.');
    for (const [key, value] of Object.entries(this.definition.palette)) {
      if (!COLOR_PATTERN.test(value)) errors.push(`Palette color '${key}' has unsupported value '${value}'.`);
    }
    for (const name of Object.keys(this.definition.semanticTokens)) {
      try { this.resolve(name, new Set(), 0); } catch (error) { errors.push(error instanceof Error ? error.message : `Could not resolve '${name}'.`); }
    }

    for (const target of contrastTargets) {
      const foreground = this.getToken(target.token)?.value;
      const background = this.getToken(target.against)?.value;
      if (!foreground || !background) continue;
      const ratio = checkContrast(foreground, background);
      if (ratio !== null && ratio < target.minimum) {
        contrastFailures.push({ ...target, actual: Number(ratio.toFixed(2)) });
      }
    }
    return { valid: errors.length === 0, errors: [...new Set(errors)], warnings, contrastFailures };
  }

  private resolve(name: string, visited: Set<string>, depth: number): string {
    const cached = this.resolved.get(name);
    if (cached) return cached;
    if (!this.definition) throw new Error('No theme is loaded.');
    if (depth > MAX_REFERENCE_DEPTH) throw new Error(`Maximum reference depth exceeded for token '${name}'.`);
    if (visited.has(name)) throw new Error(`Circular reference detected at semantic token '${name}'.`);
    const token = this.definition.semanticTokens[name];
    if (!token) throw new Error(`Semantic token '${name}' is not defined.`);
    const paletteValue = this.definition.palette[token.ref];
    if (paletteValue) {
      this.resolved.set(name, paletteValue);
      return paletteValue;
    }
    if (!this.definition.semanticTokens[token.ref]) throw new Error(`Unresolved reference: semantic token '${name}' references '${token.ref}'.`);
    const nextVisited = new Set(visited);
    nextVisited.add(name);
    const value = this.resolve(token.ref, nextVisited, depth + 1);
    this.resolved.set(name, value);
    return value;
  }
}
