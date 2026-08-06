// =============================================================================
// Byte-range helper for document viewers. Uint8Array views may sit on a shared
// ArrayBuffer (pooled decodes, subarray slices); handing `.buffer` straight to
// mammoth or pdf.js would leak neighbouring bytes into the parse. Ported from
// Cate 1.5.3 (MIT) — src/renderer/panels/documentBytes.ts.
// =============================================================================

/**
 * Returns an ArrayBuffer covering exactly the view's byte range — the backing
 * buffer itself when the view spans it, otherwise a sliced copy.
 */
export function viewedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
