import { describe, expect, it } from 'vitest';
import { viewedArrayBuffer } from '@/editor/documentBytes';
import { clampPdfScale } from '@/editor/PdfViewer';

describe('viewedArrayBuffer', () => {
  it('returns the backing buffer when the view spans it exactly', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(viewedArrayBuffer(bytes)).toBe(bytes.buffer);
  });

  it('slices a subarray view down to its exact byte range', () => {
    const backing = new Uint8Array([0, 0, 37, 80, 68, 70, 0, 0]); // junk + %PDF + junk
    const view = backing.subarray(2, 6);
    const sliced = viewedArrayBuffer(view);
    expect(sliced).not.toBe(backing.buffer);
    expect(sliced.byteLength).toBe(4);
    expect(Array.from(new Uint8Array(sliced))).toEqual([37, 80, 68, 70]);
  });

  it('does not let neighbouring bytes of a shared buffer leak into the result', () => {
    const shared = new ArrayBuffer(32);
    const all = new Uint8Array(shared);
    all.set([9, 9, 9], 0);
    all.set([80, 75, 3, 4], 8); // PK zip head inside the view
    all.set([7, 7, 7], 20);
    const view = new Uint8Array(shared, 8, 8);
    const sliced = new Uint8Array(viewedArrayBuffer(view));
    expect(sliced.length).toBe(8);
    expect(Array.from(sliced.slice(0, 4))).toEqual([80, 75, 3, 4]);
    expect(Array.from(sliced)).not.toContain(9);
    expect(Array.from(sliced)).not.toContain(7);
  });
});

describe('clampPdfScale', () => {
  it('clamps zoom to the 0.5–4.0 range', () => {
    expect(clampPdfScale(0.1)).toBe(0.5);
    expect(clampPdfScale(10)).toBe(4);
  });

  it('snaps to 0.25 steps', () => {
    expect(clampPdfScale(1.1)).toBe(1);
    expect(clampPdfScale(1.2)).toBe(1.25);
    expect(clampPdfScale(0.5)).toBe(0.5);
    expect(clampPdfScale(4)).toBe(4);
  });
});
