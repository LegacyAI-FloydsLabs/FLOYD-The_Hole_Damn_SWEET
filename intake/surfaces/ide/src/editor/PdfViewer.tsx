// =============================================================================
// PDF viewer: paged canvas rendering via pdf.js. The library and its worker
// are lazy-loaded (dynamic import + Vite asset URL) so they land in async
// chunks and never touch the main bundle budget. Ported from Cate 1.5.3 (MIT)
// — src/renderer/panels/DocumentPanel.tsx PdfViewer: DPR-scaled canvas,
// in-flight RenderTask cancellation, reloadKey retry.
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import { Icon } from '@/components/Icon';
import { viewedArrayBuffer } from './documentBytes';
import type { BinaryFile } from '@/platform';

// Vite emits the worker as a static asset and rewrites this URL at build time.
const PDF_WORKER_SRC = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

const MIN_SCALE = 0.5;
const MAX_SCALE = 4.0;
const SCALE_STEP = 0.25;

/** Zoom is clamped to a 0.5–4.0 range in 0.25 steps. */
export function clampPdfScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale / SCALE_STEP) * SCALE_STEP));
}

function isRenderCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}

export function PdfViewer({ file }: { file: BinaryFile }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);

  // Document load: pdf.js is imported on first use, the worker is pinned once,
  // and teardown rejections are swallowed (destroy() rejects when the load
  // task was never fully initialized).
  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setStatus('loading');
    setError(null);
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        loadingTask = pdfjs.getDocument({ data: new Uint8Array(viewedArrayBuffer(file.data)) });
        const document = await loadingTask.promise;
        if (cancelled) return;
        documentRef.current = document;
        setNumPages(document.numPages);
        setCurrentPage(1);
        setStatus('ready');
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Could not render this PDF.');
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      documentRef.current = null;
      loadingTask?.destroy().catch(() => {});
    };
  }, [file, reloadKey]);

  // Page render: cancel any in-flight RenderTask before starting a new one —
  // pdf.js throws RenderingCancelledException when a second render targets the
  // same canvas, so rapid page/zoom changes must supersede, not stack.
  useEffect(() => {
    if (status !== 'ready') return;
    const document = documentRef.current;
    const canvas = canvasRef.current;
    if (!document || !canvas) return;
    let cancelled = false;
    (async () => {
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      try {
        const page = await document.getPage(currentPage);
        if (cancelled) return;
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const task = page.render({ canvas, viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (renderTaskRef.current === task) renderTaskRef.current = null;
      } catch (renderError) {
        if (isRenderCancellation(renderError)) return;
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : 'Could not render this page.');
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [status, currentPage, scale, reloadKey]);

  if (status === 'error') {
    return (
      <div className="document-message">
        <Icon name="warning" size={28} />
        <strong>Could not render {file.name}</strong>
        <span>{error}</span>
        <button type="button" className="button secondary compact-button" onClick={() => setReloadKey((key) => key + 1)}>Try again</button>
      </div>
    );
  }

  return (
    <div className="document-pdf">
      <div className="document-toolbar">
        <button
          type="button"
          className="button secondary compact-button"
          disabled={currentPage <= 1}
          onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
          aria-label="Previous page"
        >‹</button>
        <span className="document-meta">Page {currentPage}{numPages > 0 ? ` / ${numPages}` : ''}</span>
        <button
          type="button"
          className="button secondary compact-button"
          disabled={numPages === 0 || currentPage >= numPages}
          onClick={() => setCurrentPage((page) => Math.min(numPages, page + 1))}
          aria-label="Next page"
        >›</button>
        <button
          type="button"
          className="button secondary compact-button"
          disabled={scale <= MIN_SCALE}
          onClick={() => setScale((value) => clampPdfScale(value - SCALE_STEP))}
          aria-label="Zoom out"
        >−</button>
        <span className="document-meta">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className="button secondary compact-button"
          disabled={scale >= MAX_SCALE}
          onClick={() => setScale((value) => clampPdfScale(value + SCALE_STEP))}
          aria-label="Zoom in"
        >+</button>
      </div>
      <div className="document-image-scroll">
        {status === 'loading' && <div className="panel-empty"><span className="progress-line" /><span>Loading {file.name}</span></div>}
        <canvas ref={canvasRef} className="document-pdf-canvas" style={status === 'ready' ? undefined : { display: 'none' }} />
      </div>
    </div>
  );
}
