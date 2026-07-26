import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('adaptive video quality', () => {
  let LiveSession;
  let ADAPTIVE_PROFILES;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../live-service.js');
    LiveSession = mod.LiveSession;
    ADAPTIVE_PROFILES = mod.ADAPTIVE_PROFILES;
  });

  function createSessionWithDiff(mockPixels, prevDiffData = null) {
    const session = new LiveSession(vi.fn(), vi.fn());
    session._diffCanvas = { width: 80, height: 60 };
    session._diffCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(mockPixels) })),
    };
    session.videoElement = { tagName: 'VIDEO' };
    session._prevDiffData = prevDiffData;
    return session;
  }

  it('_computeFrameDiff returns 50 on first frame (no previous data)', () => {
    const pixels = new Uint8ClampedArray(80 * 60 * 4);
    const session = createSessionWithDiff(pixels, null);

    const result = session._computeFrameDiff();

    expect(result).toBe(50);
    expect(session._prevDiffData).toBeInstanceOf(Uint8ClampedArray);
    expect(session._prevDiffData.length).toBe(80 * 60 * 4);
  });

  it('_computeFrameDiff returns 0 for identical frames', () => {
    const pixels = new Uint8ClampedArray(80 * 60 * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = 128;
    const session = createSessionWithDiff(pixels, new Uint8ClampedArray(pixels));

    const result = session._computeFrameDiff();

    expect(result).toBe(0);
  });

  it('_computeFrameDiff returns 100 for completely different frames', () => {
    const current = new Uint8ClampedArray(80 * 60 * 4).fill(255);
    const previous = new Uint8ClampedArray(80 * 60 * 4).fill(0);
    const session = createSessionWithDiff(current, previous);

    const result = session._computeFrameDiff();

    expect(result).toBe(100);
  });

  it('_resolveAdaptiveParams selects correct mode and respects cooldown', () => {
    const session = new LiveSession(vi.fn(), vi.fn());
    session._adaptiveMode = 'MEDIUM';
    session._lastModeSwitch = 0;

    const highParams = session._resolveAdaptiveParams(20);
    expect(session._adaptiveMode).toBe('HIGH');
    expect(highParams.fps).toBe(ADAPTIVE_PROFILES.HIGH.fps);
    expect(highParams.quality).toBe(ADAPTIVE_PROFILES.HIGH.quality);
    expect(highParams.maxWidth).toBe(ADAPTIVE_PROFILES.HIGH.maxWidth);

    const stillHigh = session._resolveAdaptiveParams(2);
    expect(session._adaptiveMode).toBe('HIGH');
    expect(stillHigh.fps).toBe(ADAPTIVE_PROFILES.HIGH.fps);
  });
});
