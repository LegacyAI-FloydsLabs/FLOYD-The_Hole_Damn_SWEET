import { PolicyModelClient } from '@/model-routing';
import { getRuntimeModelConfig } from '@/model-routing/runtimeConfig';
import type { InlineEditRequestDetail } from './types';

const SYSTEM = `You are CURSEM Inline Edit. Transform only the selected code according to the instruction. Preserve surrounding conventions. Return only the replacement text inside <replacement>...</replacement>; no explanation or Markdown.`;

export class InlineEditService {
  constructor(private readonly client = new PolicyModelClient()) {}

  async rewrite(request: InlineEditRequestDetail, instruction: string, signal: AbortSignal): Promise<string> {
    const config = getRuntimeModelConfig();
    if (config.credentialMode === 'user' && !config.apiKey.trim()) throw new Error('Enter a one-off provider key or enable the credential proxy in the CURSEM coding partner before using Inline Edit.');
    const start = offsetAt(request.fullContent, request.startLine, request.startCol);
    const end = offsetAt(request.fullContent, request.endLine, request.endCol);
    const prefix = request.fullContent.slice(Math.max(0, start - 8000), start);
    const suffix = request.fullContent.slice(end, end + 4000);
    let text = '';
    for await (const event of this.client.stream(config, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `<instruction>${instruction}</instruction>\n<file path=${JSON.stringify(request.path)} language=${JSON.stringify(request.languageId)}>\n<prefix>${prefix}</prefix>\n<selection>${request.selectedText}</selection>\n<suffix>${suffix}</suffix>\n</file>` },
      ], maxTokens: 2048, temperature: 0.15,
    }, signal)) {
      if (event.type === 'delta') text += event.text;
      if (event.type === 'error') throw new Error(typeof event.error === 'string' ? event.error : JSON.stringify(event.error));
    }
    const replacement = extractReplacement(text);
    if (!replacement && request.selectedText) throw new Error('The provider returned an empty inline edit.');
    return replacement;
  }
}

export function replaceInlineSelection(request: InlineEditRequestDetail, replacement: string): string {
  const start = offsetAt(request.fullContent, request.startLine, request.startCol);
  const end = offsetAt(request.fullContent, request.endLine, request.endCol);
  return `${request.fullContent.slice(0, start)}${replacement}${request.fullContent.slice(end)}`;
}

export function extractReplacement(text: string): string {
  const tagged = text.match(/<replacement>([\s\S]*?)<\/replacement>/i)?.[1];
  return (tagged ?? text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')).replace(/^\n/, '').replace(/\n$/, '');
}

function offsetAt(content: string, line: number, column: number): number {
  const lines = content.split('\n'); let offset = 0;
  for (let index = 0; index < Math.max(0, line - 1) && index < lines.length; index += 1) offset += lines[index].length + 1;
  return Math.min(content.length, offset + Math.max(0, column - 1));
}
