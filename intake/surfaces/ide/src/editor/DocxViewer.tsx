// =============================================================================
// DOCX viewer: converts Word documents to HTML with mammoth (lazy-loaded so it
// lands in an async chunk, off the main bundle budget) and renders the result
// after a DOMPurify pass — mammoth output is document-derived markup and must
// be treated as untrusted. Styling follows the active theme via the same CSS
// custom properties as .markdown-preview; the rules are injected with the
// component rather than added to the shared workbench stylesheet.
// =============================================================================

import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { Icon } from '@/components/Icon';
import { viewedArrayBuffer } from './documentBytes';
import type { BinaryFile } from '@/platform';

const DOCTEXT_CSS = `
.document-doctext-scroll { flex: 1; min-height: 0; overflow: auto; padding: 26px 34px 60px; background: var(--bg-editor); color: var(--text-primary); font-size: 13px; line-height: 1.65; }
.document-doctext { max-width: 780px; margin-left: auto; margin-right: auto; }
.document-doctext h1, .document-doctext h2, .document-doctext h3, .document-doctext h4, .document-doctext h5, .document-doctext h6 { margin: 1.1em auto 0.45em; color: var(--text-primary); line-height: 1.25; }
.document-doctext h1 { padding-bottom: 6px; border-bottom: 1px solid var(--border); font-size: 24px; }
.document-doctext h2 { padding-bottom: 4px; border-bottom: 1px solid var(--border); font-size: 19px; }
.document-doctext h3 { font-size: 16px; }
.document-doctext p, .document-doctext ul, .document-doctext ol, .document-doctext blockquote, .document-doctext pre, .document-doctext table { margin: 0.55em auto; }
.document-doctext a { color: var(--cyan); }
.document-doctext code { padding: 1px 5px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-surface); color: var(--accent-strong); font-size: 12px; }
.document-doctext blockquote { padding: 2px 14px; border-left: 3px solid var(--accent); color: var(--text-secondary); }
.document-doctext table { width: 100%; border-collapse: collapse; font-size: 12px; }
.document-doctext th, .document-doctext td { padding: 5px 10px; border: 1px solid var(--border); text-align: left; }
.document-doctext th { background: var(--bg-surface); color: var(--text-primary); }
.document-doctext img { max-width: 100%; border-radius: 6px; }
`;

export function DocxViewer({ file }: { file: BinaryFile }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; html: string }>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const mammoth = await import('mammoth');
        const result = await mammoth.convertToHtml({ arrayBuffer: viewedArrayBuffer(file.data) });
        if (cancelled) return;
        setState({ status: 'ready', html: DOMPurify.sanitize(result.value) });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : 'Could not render this document.' });
      }
    })();
    return () => { cancelled = true; };
  }, [file, reloadKey]);

  if (state.status === 'loading') {
    return <div className="panel-empty"><span className="progress-line" /><span>Loading {file.name}</span></div>;
  }
  if (state.status === 'error') {
    return (
      <div className="document-message">
        <Icon name="warning" size={28} />
        <strong>Could not render {file.name}</strong>
        <span>{state.message}</span>
        <button type="button" className="button secondary compact-button" onClick={() => setReloadKey((key) => key + 1)}>Try again</button>
      </div>
    );
  }
  return (
    <div className="document-doctext-scroll">
      <style>{DOCTEXT_CSS}</style>
      {/* eslint-disable-next-line react/no-danger -- sanitized by DOMPurify above */}
      <div className="document-doctext" dangerouslySetInnerHTML={{ __html: state.html }} />
    </div>
  );
}
