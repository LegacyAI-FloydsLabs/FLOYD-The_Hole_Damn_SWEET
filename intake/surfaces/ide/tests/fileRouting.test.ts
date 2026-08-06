import { describe, expect, it } from 'vitest';
import { detectTypeFromBytes, getDocumentType, isMarkdownPath } from '@/editor/fileRouting';

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe('file-open routing', () => {
  it('routes viewer extensions to document types and leaves text files alone', () => {
    expect(getDocumentType('/w/spec.pdf')).toBe('pdf');
    expect(getDocumentType('/w/report.docx')).toBe('docx');
    expect(getDocumentType('/w/photo.JPG')).toBe('image');
    expect(getDocumentType('/w/icon.svg')).toBe('image');
    expect(getDocumentType('/w/hdr.avif')).toBe('image');
    expect(getDocumentType('/w/clip.gif')).toBe('image');
    expect(getDocumentType('/w/code.ts')).toBeNull();
    expect(getDocumentType('/w/README.md')).toBeNull();
    expect(getDocumentType('/w/Makefile')).toBeNull();
  });

  it('detects markdown paths case-insensitively', () => {
    expect(isMarkdownPath('/w/notes.md')).toBe(true);
    expect(isMarkdownPath('/w/page.MDX')).toBe(true);
    expect(isMarkdownPath('/w/markdown.txt')).toBe(false);
  });

  it('sniffs magic bytes and overrides extension guesses', () => {
    expect(detectTypeFromBytes(text('%PDF-1.7'))).toMatchObject({ documentType: 'pdf' });
    expect(detectTypeFromBytes(bytes(0xFF, 0xD8, 0xFF, 0xE0))).toMatchObject({ documentType: 'image', mimeType: 'image/jpeg' });
    expect(detectTypeFromBytes(bytes(0x89, 0x50, 0x4E, 0x47))).toMatchObject({ documentType: 'image', mimeType: 'image/png' });
    expect(detectTypeFromBytes(text('GIF89a'))).toMatchObject({ documentType: 'image', mimeType: 'image/gif' });
    expect(detectTypeFromBytes(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toMatchObject({ documentType: 'image', mimeType: 'image/webp' });
    expect(detectTypeFromBytes(text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toMatchObject({ documentType: 'image', mimeType: 'image/svg+xml' });
  });

  it('classifies ZIP containers by their word/ entries', () => {
    const docx = new Uint8Array(64);
    docx.set(bytes(0x50, 0x4B, 0x03, 0x04));
    docx.set(text('word/document.xml'), 20);
    expect(detectTypeFromBytes(docx)).toMatchObject({ documentType: 'docx' });

    const jar = new Uint8Array(64);
    jar.set(bytes(0x50, 0x4B, 0x03, 0x04));
    jar.set(text('META-INF/MANIFEST.MF'), 20);
    expect(detectTypeFromBytes(jar)).toMatchObject({ documentType: 'binary', mimeType: 'application/zip' });
  });

  it('flags NUL-containing data as binary and plain text as not-a-document', () => {
    expect(detectTypeFromBytes(bytes(0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00))).toMatchObject({ documentType: 'binary' });
    expect(detectTypeFromBytes(text('const answer = 42;\n'))).toBeNull();
    expect(detectTypeFromBytes(bytes(1, 2))).toBeNull();
  });
});
