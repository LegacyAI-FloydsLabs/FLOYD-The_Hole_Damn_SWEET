import { useMemo } from 'react';
import { renderMarkdown } from './markdown';

/** Theme-following rendered markdown (colors come from the active theme's
 *  CSS custom properties — see .markdown-preview in workbench.css). */
export function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  // eslint-disable-next-line react/no-danger -- sanitized by DOMPurify in renderMarkdown
  return <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}
