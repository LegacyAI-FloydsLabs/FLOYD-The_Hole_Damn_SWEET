// =============================================================================
// Document viewer pane: renders binary document tabs (image / PDF / DOCX /
// generic binary) inside the existing editor tab system. Byte sniffing
// overrides the extension-derived type so misnamed files still render.
//
// The image viewer uses a Blob URL (CSP allows img-src blob:). PDF (pdf.js)
// and DOCX (mammoth) rendering require runtime dependencies that are not
// installed in this build; those types get a clean unsupported state with a
// download affordance instead of mojibake in Monaco.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useWorkspace } from '@/workspace';
import { detectTypeFromBytes, getDocumentType, type DocumentType } from './fileRouting';
import type { BinaryFile } from '@/platform';

interface LoadedDocument {
  file: BinaryFile;
  documentType: DocumentType;
  mimeType: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function useObjectUrl(data: Uint8Array | null, mime: string): string | null {
  return useMemo(() => {
    if (!data) return null;
    const copy = new Uint8Array(data);
    return URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
  }, [data, mime]);
}

function ImageViewer({ file, mimeType }: { file: BinaryFile; mimeType: string }) {
  const url = useObjectUrl(file.data, mimeType);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (!url) return null;
  return (
    <div className="document-image-scroll">
      <img className="document-image" src={url} alt={file.name} draggable={false} />
    </div>
  );
}

const UNSUPPORTED_COPY: Record<Exclude<DocumentType, 'image'>, { title: string; detail: string }> = {
  pdf: { title: 'PDF document', detail: 'PDF preview needs the pdf.js renderer, which is not bundled in this build.' },
  docx: { title: 'Word document', detail: 'DOCX preview needs the mammoth converter, which is not bundled in this build.' },
  binary: { title: 'Binary file', detail: 'This file is not text and has no viewer.' },
};

function UnsupportedViewer({ file, documentType }: { file: BinaryFile; documentType: Exclude<DocumentType, 'image'> }) {
  const url = useObjectUrl(file.data, file.mime);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const copy = UNSUPPORTED_COPY[documentType];
  const download = () => {
    if (!url) return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
  };
  return (
    <div className="document-message">
      <Icon name="image" size={28} />
      <strong>{copy.title}</strong>
      <span>{copy.detail}</span>
      <span className="document-meta">{file.name} · {formatSize(file.size)}</span>
      <button type="button" className="button secondary compact-button" onClick={download}>Download a copy</button>
    </div>
  );
}

export function DocumentPane({ path }: { path: string }) {
  const { fs } = useWorkspace();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; document: LoadedDocument }>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fs.readBinary(path)
      .then((file) => {
        if (cancelled) return;
        // Sniffing wins; the extension-derived type is the fallback (AVIF has
        // no magic-byte rule above, a stripped SVG head may not sniff, etc.).
        const sniffed = detectTypeFromBytes(file.data);
        const extensionType = getDocumentType(path);
        setState({
          status: 'ready',
          document: {
            file,
            documentType: sniffed?.documentType ?? extensionType ?? 'binary',
            mimeType: sniffed?.mimeType ?? (file.mime || 'application/octet-stream'),
          },
        });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : `Could not open ${path}.` });
      });
    return () => { cancelled = true; };
  }, [fs, path, reloadKey]);

  const fileName = path.split('/').pop() ?? path;

  if (state.status === 'loading') {
    return <div className="document-pane"><div className="panel-empty"><span className="progress-line" /><span>Loading {fileName}</span></div></div>;
  }
  if (state.status === 'error') {
    return (
      <div className="document-pane">
        <div className="document-message">
          <Icon name="warning" size={28} />
          <strong>Could not open {fileName}</strong>
          <span>{state.message}</span>
          <button type="button" className="button secondary compact-button" onClick={() => setReloadKey((key) => key + 1)}>Try again</button>
        </div>
      </div>
    );
  }

  const { file, documentType, mimeType } = state.document;
  return (
    <div className="document-pane">
      {documentType === 'image'
        ? <ImageViewer file={file} mimeType={mimeType} />
        : <UnsupportedViewer file={file} documentType={documentType} />}
    </div>
  );
}
