// =============================================================================
// File-open routing: files the editor can't serve as text open as document
// viewer tabs instead of mojibake. Routing is by extension at click time;
// the viewer re-sniffs magic bytes and overrides the guess (a misnamed file
// still renders). Magic-byte detection is ported from Cate 1.5.3 (MIT) —
// src/renderer/panels/DocumentPanel.tsx detectTypeFromBytes.
// =============================================================================

export type DocumentType = 'image' | 'pdf' | 'docx' | 'binary';

export interface DetectedType {
  documentType: DocumentType;
  mimeType: string;
}

const DOCUMENT_EXTENSIONS: Record<string, DocumentType> = {
  pdf: 'pdf',
  docx: 'docx',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image',
  webp: 'image', avif: 'image', bmp: 'image', ico: 'image', tif: 'image', tiff: 'image',
};

/** Extension-derived document type, or null for editor (text) files. */
export function getDocumentType(path: string): DocumentType | null {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return DOCUMENT_EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function isMarkdownPath(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

/** Sniff magic bytes; the result overrides the extension-derived type. */
export function detectTypeFromBytes(bytes: Uint8Array): DetectedType | null {
  if (bytes.length < 4) return null;

  // PDF: starts with %PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return { documentType: 'pdf', mimeType: 'application/pdf' };
  }

  // JPEG: starts with FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { documentType: 'image', mimeType: 'image/jpeg' };
  }

  // PNG: starts with 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { documentType: 'image', mimeType: 'image/png' };
  }

  // GIF: starts with GIF8
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { documentType: 'image', mimeType: 'image/gif' };
  }

  // WebP: starts with RIFF....WEBP
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { documentType: 'image', mimeType: 'image/webp' };
  }

  // BMP: starts with BM
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return { documentType: 'image', mimeType: 'image/bmp' };
  }

  // TIFF: starts with II (little-endian) or MM (big-endian)
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A && bytes[3] === 0x00) ||
      (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[2] === 0x00 && bytes[3] === 0x2A)) {
    return { documentType: 'image', mimeType: 'image/tiff' };
  }

  // ICO: starts with 00 00 01 00
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return { documentType: 'image', mimeType: 'image/x-icon' };
  }

  // SVG: look for <svg near the start
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 256));
  if (head.includes('<svg')) {
    return { documentType: 'image', mimeType: 'image/svg+xml' };
  }

  // DOCX (ZIP with PK signature — check for a word/ entry marker)
  if (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const asText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 2000));
    if (asText.includes('word/')) {
      return { documentType: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    }
    return { documentType: 'binary', mimeType: 'application/zip' };
  }

  // Generic binary: NUL byte in the first 8 KB is a reliable non-text signal.
  if (bytes.slice(0, 8192).includes(0)) {
    return { documentType: 'binary', mimeType: 'application/octet-stream' };
  }

  return null;
}
