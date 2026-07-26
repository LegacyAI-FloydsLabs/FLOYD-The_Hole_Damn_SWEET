// gif-recorder.js — Open Anvil
// GIF recording pipeline with action overlay drawing for the offscreen document.
// PoC: Collects frames with overlays; actual GIF encoding deferred to gif.js bundling.
'use strict';

const MAX_FRAMES = 100;

// ─── Recording State ────────────────────────────────────────────────────────

let recordingState = null;

function createRecordingState() {
  return {
    recording: true,
    frames: [],       // Array of { dataUrl: string, timestamp: number }
    startTime: Date.now()
  };
}

// ─── Overlay Drawing Functions ──────────────────────────────────────────────

/**
 * Draw a click indicator: orange circle with crosshair at (x, y).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x - scaled x coordinate
 * @param {number} y - scaled y coordinate
 */
function drawClickIndicator(ctx, x, y) {
  const radius = 15;

  // Orange circle fill
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(207, 107, 60, 0.8)';
  ctx.fill();

  // Crosshair lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(x - radius, y);
  ctx.lineTo(x + radius, y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x, y - radius);
  ctx.lineTo(x, y + radius);
  ctx.stroke();
}

/**
 * Draw a drag path: red arrow line from (x1,y1) to (x2,y2).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x1 - start x
 * @param {number} y1 - start y
 * @param {number} x2 - end x
 * @param {number} y2 - end y
 */
function drawDragPath(ctx, x1, y1, x2, y2) {
  // Main line
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = 'rgba(220, 50, 50, 0.85)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Arrowhead
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = 12;

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle - Math.PI / 6),
    y2 - headLen * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    x2 - headLen * Math.cos(angle + Math.PI / 6),
    y2 - headLen * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fillStyle = 'rgba(220, 50, 50, 0.85)';
  ctx.fill();
}

/**
 * Draw an action label: dark tooltip with white text below (x, y).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x - label anchor x
 * @param {number} y - label anchor y
 * @param {string} text - label text
 */
function drawActionLabel(ctx, x, y, text) {
  const fontSize = 12;
  const padding = 6;
  const offsetY = 24; // below the action point

  ctx.font = `${fontSize}px sans-serif`;
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width || (text.length * fontSize * 0.6);
  const boxWidth = textWidth + padding * 2;
  const boxHeight = fontSize + padding * 2;
  const boxX = x - boxWidth / 2;
  const boxY = y + offsetY;

  // Dark background
  ctx.fillStyle = 'rgba(30, 30, 30, 0.85)';
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 4);
  ctx.fill();

  // White text
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, boxY + padding);

  // Reset alignment
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

/**
 * Draw a thin progress bar at the bottom of the canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width - canvas width
 * @param {number} height - canvas height
 * @param {number} progress - 0..1 fraction
 */
function drawProgressBar(ctx, width, height, progress) {
  const barHeight = 4;
  const barY = height - barHeight;

  // Background track
  ctx.fillStyle = 'rgba(60, 60, 60, 0.5)';
  ctx.fillRect(0, barY, width, barHeight);

  // Progress fill
  const clampedProgress = Math.max(0, Math.min(1, progress));
  ctx.fillStyle = 'rgba(207, 107, 60, 0.9)';
  ctx.fillRect(0, barY, width * clampedProgress, barHeight);
}

/**
 * Draw a semi-transparent "Anvil" watermark at bottom-right corner.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width - canvas width
 * @param {number} height - canvas height
 */
function drawWatermark(ctx, width, height) {
  const fontSize = 11;
  const margin = 8;

  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = 'rgba(180, 180, 180, 0.45)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('Anvil', width - margin, height - margin - 4); // above progress bar

  // Reset alignment
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

// ─── Overlay Dispatcher ─────────────────────────────────────────────────────

/**
 * Apply action overlays onto a canvas context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} action - { type, x, y, x2, y2, label }
 * @param {number} scaleFactor
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {number} progress - recording progress 0..1
 */
function applyOverlays(ctx, action, scaleFactor, canvasWidth, canvasHeight, progress) {
  if (action) {
    const sx = (action.x || 0) * scaleFactor;
    const sy = (action.y || 0) * scaleFactor;

    switch (action.type) {
      case 'click':
        drawClickIndicator(ctx, sx, sy);
        if (action.label) drawActionLabel(ctx, sx, sy, action.label);
        break;

      case 'drag': {
        const sx2 = (action.x2 || 0) * scaleFactor;
        const sy2 = (action.y2 || 0) * scaleFactor;
        drawDragPath(ctx, sx, sy, sx2, sy2);
        if (action.label) drawActionLabel(ctx, sx, sy, action.label);
        break;
      }

      case 'label':
        drawActionLabel(ctx, sx, sy, action.label || '');
        break;

      default:
        // Unknown action type — draw label if present
        if (action.label) drawActionLabel(ctx, sx, sy, action.label);
        break;
    }
  }

  drawProgressBar(ctx, canvasWidth, canvasHeight, progress);
  drawWatermark(ctx, canvasWidth, canvasHeight);
}

// ─── Tool Functions ─────────────────────────────────────────────────────────

/**
 * Initialize GIF recording state.
 * @returns {{ success: boolean, recording: boolean }}
 */
function gifStart() {
  // Clean up any prior state
  if (recordingState) {
    recordingState.frames = [];
    recordingState = null;
  }

  recordingState = createRecordingState();
  return { success: true, recording: true };
}

/**
 * Add a frame with overlay drawn on it.
 * @param {{ imageData: string, action?: object, viewportWidth: number, viewportHeight: number }} params
 *   imageData: base64 PNG data URL of the screenshot
 *   action: { type: 'click'|'drag'|'label', x, y, x2?, y2?, label? }
 *   viewportWidth / viewportHeight: original viewport dimensions for coordinate scaling
 * @returns {{ success: boolean, frameIndex: number, totalFrames: number }}
 */
function gifAddFrame(params) {
  if (!recordingState || !recordingState.recording) {
    return { success: false, error: 'Recording not started. Call gifStart() first.' };
  }

  if (recordingState.frames.length >= MAX_FRAMES) {
    return { success: false, error: `Frame limit reached (${MAX_FRAMES}). Call gifStop() to finalize.` };
  }

  const { imageData, action, viewportWidth, viewportHeight } = params || {};

  if (!imageData) {
    return { success: false, error: 'imageData is required (base64 PNG data URL).' };
  }

  const vw = viewportWidth || 1280;
  const vh = viewportHeight || 720;

  // Create canvas to composite screenshot + overlays
  const canvas = document.createElement('canvas');
  canvas.width = vw;
  canvas.height = vh;
  const ctx = canvas.getContext('2d');

  // For the PoC, we draw overlays onto a blank canvas matching viewport dimensions.
  // In production, we'd first draw the screenshot image, then overlays on top.
  // The screenshot imageData is preserved as-is alongside the overlay canvas.
  const scaleFactor = canvas.width / vw; // 1.0 when canvas matches viewport
  const progress = recordingState.frames.length / MAX_FRAMES;

  applyOverlays(ctx, action, scaleFactor, canvas.width, canvas.height, progress);

  // Capture the overlay canvas as data URL
  let overlayDataUrl;
  try {
    overlayDataUrl = canvas.toDataURL('image/png');
  } catch (_e) {
    // In test environments, canvas.toDataURL may not be available
    overlayDataUrl = 'data:image/png;base64,OVERLAY_STUB';
  }

  const frameIndex = recordingState.frames.length;
  recordingState.frames.push({
    screenshot: imageData,
    overlay: overlayDataUrl,
    action: action || null,
    timestamp: Date.now()
  });

  return { success: true, frameIndex, totalFrames: recordingState.frames.length };
}

/**
 * Finalize recording: compile frames and return result.
 * Actual GIF encoding is deferred until gif.js is bundled.
 * For the PoC, returns frame data as base64 PNG references.
 * @param {{ filename?: string }} params
 * @returns {{ success: boolean, frameCount: number, filename: string, frames?: Array }}
 */
function gifStop(params) {
  if (!recordingState || !recordingState.recording) {
    return { success: false, error: 'No active recording to stop.' };
  }

  const filename = (params && params.filename) || `anvil-recording-${Date.now()}.gif`;
  const frameCount = recordingState.frames.length;

  // Collect frame references for the PoC output
  const frameRefs = recordingState.frames.map((f, i) => ({
    index: i,
    hasAction: f.action !== null,
    actionType: f.action ? f.action.type : null,
    timestamp: f.timestamp
  }));

  // TODO: When gif.js is bundled, encode frames here:
  // const encoder = new GIF({ workers: 2, quality: 10, width, height });
  // for (const frame of recordingState.frames) { encoder.addFrame(frameCanvas, { delay: 200 }); }
  // const blob = await new Promise(resolve => { encoder.on('finished', resolve); encoder.render(); });

  // Clean up — do NOT store frames indefinitely
  recordingState.frames = [];
  recordingState.recording = false;
  recordingState = null;

  return {
    success: true,
    frameCount,
    filename,
    frames: frameRefs,
    encoding: 'deferred' // Indicates gif.js not yet bundled
  };
}

// ─── Expose on globalThis ───────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  globalThis.gifStart = gifStart;
  globalThis.gifAddFrame = gifAddFrame;
  globalThis.gifStop = gifStop;
}

// ─── Exports for testing ────────────────────────────────────────────────────

// INTEGRATION: Add to background.js handleBrowserApiTool():
//   case 'gif_start':   → route to offscreen with { type: 'GENERATE_GIF', command: 'gif_start' }
//   case 'gif_add_frame': → route to offscreen with { type: 'GENERATE_GIF', command: 'gif_add_frame', data: { imageData, action, viewportWidth, viewportHeight } }
//   case 'gif_stop':    → route to offscreen with { type: 'GENERATE_GIF', command: 'gif_stop', data: { filename } }

export {
  gifStart,
  gifAddFrame,
  gifStop,
  drawClickIndicator,
  drawDragPath,
  drawActionLabel,
  drawProgressBar,
  drawWatermark,
  applyOverlays,
  MAX_FRAMES
};
