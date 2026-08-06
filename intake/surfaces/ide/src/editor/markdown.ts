// =============================================================================
// Theme-following markdown preview renderer.
//
// react-markdown/remark-gfm are not installed in this surface, and new runtime
// dependencies need an explicit decision — so this is a compact,
// dependency-free renderer covering the common document subset (headings,
// emphasis, code, lists, tables, blockquotes, links, images). Every produced
// document passes through DOMPurify as the XSS backstop; link/image URL
// protocols are additionally allow-listed at generation time.
// =============================================================================

import DOMPurify from 'dompurify';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** http(s), mailto, anchors, and root/relative paths only — never javascript:. */
function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^(#|\/|\.\/|\.\.\/)/.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // unknown scheme
  return trimmed; // bare relative path
}

function safeImageUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^(https?:|blob:|data:image\/)/i.test(trimmed)) return trimmed;
  return safeUrl(trimmed);
}

/** Inline markup on already-escaped text. */
function renderInline(escaped: string): string {
  let out = escaped;
  // Images first so their bracket syntax can't be eaten by the link rule.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string, url: string) => {
    const safe = safeImageUrl(url);
    return safe ? `<img src="${safe}" alt="${alt}" />` : alt;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, text: string, url: string) => {
    const safe = safeUrl(url);
    return safe ? `<a href="${safe}" target="_blank" rel="noreferrer noopener">${text}</a>` : text;
  });
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\b_([^_]+)_\b/g, '<em>$1</em>');
  return out;
}

const inline = (raw: string) => renderInline(escapeHtml(raw));

function isTableDelimiter(line: string): boolean {
  return /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes('-');
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function renderBlocks(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) { index++; continue; }

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) { body.push(lines[index]); index++; }
      index++; // closing fence
      const language = fence[1] ? ` class="language-${fence[1]}"` : '';
      html.push(`<pre><code${language}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html.push('<hr />');
      index++;
      continue;
    }

    // Table: header row + delimiter row
    if (line.includes('|') && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index++;
      }
      const head = headers.map((cell) => `<th>${inline(cell)}</th>`).join('');
      const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('');
      html.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index++;
      }
      html.push(`<blockquote>${renderBlocks(quote.join('\n'))}</blockquote>`);
      continue;
    }

    // Lists (single level; ordered and unordered)
    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (unordered || ordered) {
      const tag = ordered ? 'ol' : 'ul';
      const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(pattern);
        if (!item) break;
        items.push(`<li>${inline(item[1])}</li>`);
        index++;
      }
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // Paragraph — gather until a blank line or a block starter
    const paragraph: string[] = [line];
    index++;
    while (index < lines.length && lines[index].trim()
      && !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[index])
      && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])) {
      paragraph.push(lines[index]);
      index++;
    }
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }

  return html.join('\n');
}

/** Render markdown to sanitized, theme-following HTML. */
export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(renderBlocks(source), { USE_PROFILES: { html: true } }) as string;
}
