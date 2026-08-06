import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@/editor/markdown';

describe('markdown preview renderer', () => {
  it('renders headings, emphasis, and inline code', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and *italic* and `code`.');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
  });

  it('renders fenced code blocks escaped', () => {
    const html = renderMarkdown('```ts\nconst x = "<tag>";\n```');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('&lt;tag&gt;');
    expect(html).not.toContain('<tag>');
  });

  it('renders GFM-style tables', () => {
    const html = renderMarkdown('| Name | Value |\n| --- | --- |\n| a | 1 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td>a</td>');
  });

  it('renders lists, quotes, and rules', () => {
    expect(renderMarkdown('- one\n- two')).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(renderMarkdown('1. one\n2. two')).toContain('<ol>');
    expect(renderMarkdown('> quoted')).toContain('<blockquote>');
    expect(renderMarkdown('---')).toContain('<hr');
  });

  it('allows safe link protocols and neutralizes javascript: URLs', () => {
    const html = renderMarkdown('[ok](https://example.com) [bad](javascript:alert(1))');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('bad');
  });

  it('strips injected markup and event handlers', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');

    const image = renderMarkdown('![x](javascript:alert(1))');
    expect(image).not.toContain('<img');
    expect(image).not.toContain('javascript:');
  });

  it('escapes raw HTML in paragraphs', () => {
    const html = renderMarkdown('a <img src=x onerror=alert(1)> b');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
