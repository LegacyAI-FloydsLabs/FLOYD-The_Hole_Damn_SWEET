import { beforeEach, describe, expect, it, vi } from 'vitest';

function createMockCanvasContext() {
  return {
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 60 })),
    roundRect: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic'
  };
}

function createMockCanvas(width, height) {
  const ctx = createMockCanvasContext();
  return {
    width,
    height,
    getContext: vi.fn(() => ctx),
    toDataURL: vi.fn(() => 'data:image/png;base64,MOCK_PNG_DATA'),
    _ctx: ctx
  };
}

describe('GIF recorder smoke tests', () => {
  let gifStart, gifAddFrame, gifStop, drawClickIndicator, drawDragPath;
  let drawActionLabel, drawProgressBar, drawWatermark, applyOverlays, MAX_FRAMES;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const origCreateElement = document.createElement;
    document.createElement = vi.fn((tag) => {
      if (tag === 'canvas') return createMockCanvas(1280, 720);
      return origCreateElement(tag);
    });

    const mod = await import('../gif-recorder.js');
    gifStart = mod.gifStart;
    gifAddFrame = mod.gifAddFrame;
    gifStop = mod.gifStop;
    drawClickIndicator = mod.drawClickIndicator;
    drawDragPath = mod.drawDragPath;
    drawActionLabel = mod.drawActionLabel;
    drawProgressBar = mod.drawProgressBar;
    drawWatermark = mod.drawWatermark;
    applyOverlays = mod.applyOverlays;
    MAX_FRAMES = mod.MAX_FRAMES;
  });

  it('full lifecycle: start → add frames → stop', () => {
    const startResult = gifStart();
    expect(startResult).toEqual({ success: true, recording: true });

    const frame1 = gifAddFrame({
      imageData: 'data:image/png;base64,SCREENSHOT1',
      action: { type: 'click', x: 100, y: 200, label: 'Submit' },
      viewportWidth: 1280,
      viewportHeight: 720
    });
    expect(frame1.success).toBe(true);
    expect(frame1.frameIndex).toBe(0);
    expect(frame1.totalFrames).toBe(1);

    const frame2 = gifAddFrame({
      imageData: 'data:image/png;base64,SCREENSHOT2',
      action: { type: 'drag', x: 10, y: 20, x2: 300, y2: 400 },
      viewportWidth: 1280,
      viewportHeight: 720
    });
    expect(frame2.frameIndex).toBe(1);
    expect(frame2.totalFrames).toBe(2);

    const stopResult = gifStop({ filename: 'test-recording.gif' });
    expect(stopResult.success).toBe(true);
    expect(stopResult.frameCount).toBe(2);
    expect(stopResult.filename).toBe('test-recording.gif');
    expect(stopResult.encoding).toBe('deferred');
    expect(stopResult.frames).toHaveLength(2);
    expect(stopResult.frames[0].hasAction).toBe(true);
    expect(stopResult.frames[0].actionType).toBe('click');
  });

  it('rejects frames when recording not started', () => {
    const result = gifAddFrame({
      imageData: 'data:image/png;base64,X',
      viewportWidth: 1280,
      viewportHeight: 720
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not started/i);
  });

  it('enforces MAX_FRAMES cap of 100', () => {
    expect(MAX_FRAMES).toBe(100);

    gifStart();

    for (let i = 0; i < MAX_FRAMES; i++) {
      const r = gifAddFrame({
        imageData: `data:image/png;base64,FRAME_${i}`,
        viewportWidth: 1280,
        viewportHeight: 720
      });
      expect(r.success).toBe(true);
    }

    const overflow = gifAddFrame({
      imageData: 'data:image/png;base64,OVERFLOW',
      viewportWidth: 1280,
      viewportHeight: 720
    });
    expect(overflow.success).toBe(false);
    expect(overflow.error).toMatch(/limit reached/i);

    const stop = gifStop({});
    expect(stop.frameCount).toBe(MAX_FRAMES);
  });

  it('cleans up state after gifStop — no lingering frame data', () => {
    gifStart();
    gifAddFrame({
      imageData: 'data:image/png;base64,DATA',
      viewportWidth: 1280,
      viewportHeight: 720
    });
    gifStop({ filename: 'cleanup-test.gif' });

    const afterStop = gifAddFrame({
      imageData: 'data:image/png;base64,LATE',
      viewportWidth: 1280,
      viewportHeight: 720
    });
    expect(afterStop.success).toBe(false);
    expect(afterStop.error).toMatch(/not started/i);
  });

  it('draws all overlay types without throwing', () => {
    const ctx = createMockCanvasContext();

    drawClickIndicator(ctx, 100, 200);
    expect(ctx.arc).toHaveBeenCalledWith(100, 200, 15, 0, Math.PI * 2);

    drawDragPath(ctx, 10, 20, 300, 400);
    expect(ctx.moveTo).toHaveBeenCalledWith(10, 20);
    expect(ctx.lineTo).toHaveBeenCalledWith(300, 400);

    drawActionLabel(ctx, 50, 50, 'Click here');
    expect(ctx.fillText).toHaveBeenCalled();
    const labelCall = ctx.fillText.mock.calls.find(c => c[0] === 'Click here');
    expect(labelCall).toBeDefined();

    drawProgressBar(ctx, 1280, 720, 0.5);
    expect(ctx.fillRect).toHaveBeenCalled();

    drawWatermark(ctx, 1280, 720);
    const watermarkCall = ctx.fillText.mock.calls.find(c => c[0] === 'Floyd');
    expect(watermarkCall).toBeDefined();
  });
});
