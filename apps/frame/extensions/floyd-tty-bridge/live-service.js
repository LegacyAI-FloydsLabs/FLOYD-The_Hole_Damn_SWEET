/**
 * live-service.js
 *
 * Vanilla JavaScript ES module conversion of Tom_The_Peep/services/liveService.ts
 * for use in a Chrome extension side panel.
 *
 * OPTIMIZED: Circuit Breakers, Auto-Barge-in, Worklet Batching, Load Shedding.
 */

import { GoogleGenAI, Modality } from './lib/genai.mjs';
import { LIVE_VISION_TOOLS } from './vision-tools.js';

// ---------------------------------------------------------------------------
// Cached GoogleGenAI singleton
// ---------------------------------------------------------------------------

let _genAI = null;

async function getGenAI() {
  if (_genAI) return _genAI;

  const result = await chrome.storage.local.get('gemini_api_key');
  const apiKey = result.gemini_api_key;
  if (!apiKey) {
    throw new Error(
      'Missing Gemini API key. Set "gemini_api_key" in chrome.storage.local before calling Gemini services.',
    );
  }
  _genAI = new GoogleGenAI({ apiKey });
  return _genAI;
}

// ---------------------------------------------------------------------------
// Adaptive video quality profiles
// ---------------------------------------------------------------------------

const ADAPTIVE_PROFILES = {
  HIGH:   { fps: 1.5, quality: 0.3, maxWidth: 640,  intervalMs: 666  }, // Capped for Voice Mode
  MEDIUM: { fps: 1,   quality: 0.4, maxWidth: 640,  intervalMs: 1000 },
  LOW:    { fps: 0.5, quality: 0.6, maxWidth: 1280, intervalMs: 2000 },
};

const ADAPTIVE_DIFF_W = 80;
const ADAPTIVE_DIFF_H = 60;
const ADAPTIVE_PIXEL_SAMPLE_STEP = 10;
const ADAPTIVE_PIXEL_THRESHOLD = 30;
const ADAPTIVE_MODE_COOLDOWN_MS = 1000;

// ---------------------------------------------------------------------------
// LiveSession
// ---------------------------------------------------------------------------

class LiveSession {
  state = 'idle';

  // Audio contexts and nodes
  inputAudioContext = null;
  outputAudioContext = null;
  inputSource = null;
  processor = null;
  workletNode = null;
  outputNode = null;
  nextStartTime = 0;
  sources = new Set();
  suppressOutputUntilMs = 0;
  lastOutputAtMs = 0;

  // Secret Sauce 1: Audio Batching Buffer
  _audioBuffer = [];

  // Tuned Noise gate thresholds
  silenceThreshold = 0.02;
  echoRejectThreshold = 0.10;
  echoTailMs = 1200;

  // Circuit Breaker to prevent API bans
  _consecutiveSendErrors = 0;
  _maxConsecutiveErrors = 5;

  // Session management
  activeSession = null;
  stream = null;
  abortController = null;
  reconnectAttempts = 0;
  maxReconnectAttempts = 5;
  reconnectDelay = 1000;
  isIntentionalDisconnect = false;
  reconnectTimeout = null;

  // Memory and video
  currentSessionId = null;
  videoElement = null;
  canvasElement = null;
  videoInterval = null;
  videoStream = null;

  // Adaptive video quality state
  _prevDiffData = null;
  _diffCanvas = null;
  _diffCtx = null;
  _adaptiveMode = 'MEDIUM';
  _lastModeSwitch = 0;
  _videoTimeout = null;

  transcriptBuffer = [];

  constructor(onMessage, onAudioData, onError, onStatusChange, toolExecutor) {
    this.onMessage = onMessage;
    this.onAudioData = onAudioData;
    this.onError = onError;
    this.onStatusChange = onStatusChange;
    this.toolExecutor = toolExecutor;
  }

  getState() {
    return this.state;
  }

  isConnected() {
    return this.state === 'connected';
  }

  async sendText(text) {
    if (this.state !== 'connected' || !this.activeSession) return false;
    try {
      const session = await this.activeSession;
      if (!session || this.state !== 'connected') return false;
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      });
      return true;
    } catch (err) {
      console.warn('[Live] Failed to send text:', err);
      return false;
    }
  }

  isSpeaking() {
    return this.sources.size > 0;
  }

  isSpeakingOrRecently(graceMs = 1200) {
    if (this.isSpeaking()) return true;
    return Date.now() - this.lastOutputAtMs < graceMs;
  }

  interrupt(options) {
    const suppressMs = options?.suppressMs ?? 1200;
    this.suppressOutputUntilMs = Date.now() + suppressMs;

    this.sources.forEach((s) => {
      try { s.stop(); } catch (_) { /* ignore */ }
    });
    this.sources.clear();
    this.nextStartTime = 0;

    this.activeSession
      ?.then((session) => {
        try {
          // Flush the server's ongoing generation
          session.sendClientContent({ turnComplete: true });
        } catch (_) { /* ignore */ }
      })
      .catch(() => {});
  }

  async connect(externalStream, systemInstruction, options) {
    if (this.state !== 'idle' && this.state !== 'reconnecting') return;

    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const wasReconnecting = this.state === 'reconnecting';
    this.state = wasReconnecting ? 'reconnecting' : 'connecting';
    this.onStatusChange?.(this.state);
    this._consecutiveSendErrors = 0;
    this._audioBuffer = []; // Reset batch buffer

    try {
      if (signal.aborted) return;
      this.stream = externalStream || (await navigator.mediaDevices.getUserMedia({ audio: true }));

      if (signal.aborted) {
        this.stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const WebkitAudioContext = window.webkitAudioContext;
      const AudioContextCtor = window.AudioContext ?? WebkitAudioContext;
      if (!AudioContextCtor) throw new Error('AudioContext is not available.');

      this.inputAudioContext = new AudioContextCtor({ sampleRate: 16000 });
      if (this.inputAudioContext.state === 'suspended') await this.inputAudioContext.resume();

      this.outputAudioContext = new AudioContextCtor({ sampleRate: 24000 });
      if (this.outputAudioContext.state === 'suspended') await this.outputAudioContext.resume();
      this.outputNode = this.outputAudioContext.createGain();
      this.outputNode.connect(this.outputAudioContext.destination);
      this.nextStartTime = 0;

      if (signal.aborted) return;

      const voiceName = options?.voice || 'Puck';

      const finalInstruction =
        systemInstruction ||
        `You are Tom the Peep. You are the eyes and browser hands of Floyd's Labs.
IDENTITY: You see the screen, hear the user, and control the browser. You do NOT control the terminal or OS. To run a shell command, return a "floyd_command" field in your tool response.

RULE 1 — ALWAYS RESPOND: Every time the user speaks, you speak back instantly. No silence.
RULE 2 — NO FILLER: One to two sentences max. Do not use filler phrases like "Okay," "Sure," or "Let me check." State the answer or confirm the action immediately.
RULE 3 — ACT INSTANTLY: When told to click, type, or navigate, use your tools IMMEDIATELY. Do not explain what you plan to do. Do it, then report briefly ("clicked it", "typed it").
RULE 4 — DESCRIBE CLEARLY: Give concrete details of the screen: element names, text, colors, layout.

You are direct, confident, and optimized for maximum speed.`;

      const genAI = await getGenAI();
      if (signal.aborted) return;

      const sessionPromise = genAI.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          systemInstruction: finalInstruction,
          tools: [LIVE_VISION_TOOLS],
        },
        callbacks: {
          onopen: () => {
            if (signal.aborted) return;

            console.log('Live session connected');
            this.state = 'connected';
            this.reconnectAttempts = 0;
            this._consecutiveSendErrors = 0;
            this.lastServerMessageAt = Date.now();
            this.onStatusChange?.(this.state);

            if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = setInterval(() => {
              if (this.state !== 'connected') {
                clearInterval(this._heartbeatTimer);
                return;
              }
              const silentSec = Math.round((Date.now() - this.lastServerMessageAt) / 1000);
              if (silentSec > 60) {
                console.warn(`[Live] No server message for ${silentSec}s — session likely dead, reconnecting`);
                clearInterval(this._heartbeatTimer);
                this.attemptReconnect();
              }
            }, 15000);

            sessionPromise.then((session) => {
              if (this.state === 'connected' && session) {
                try {
                  session.sendClientContent({
                    turns: [{ role: 'user', parts: [{ text: 'Ready. Stay silent until I speak to you or you have a tool result.' }] }],
                    turnComplete: true,
                  });
                } catch (_) { /* ignore */ }
              }
            }).catch(() => {});

            const stream = this.stream;
            if (!stream) return;
            this.initAudioInput(stream, sessionPromise).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              this.onError?.({ type: 'audio_context_error', message: msg });
            });
          },
          onmessage: async (message) => {
            if (signal.aborted || this.state !== 'connected') return;
            this.lastServerMessageAt = Date.now();

            const toolCall = message.toolCall;
            if (toolCall?.functionCalls) {
              const functionResponses = [];
              for (const fc of toolCall.functionCalls) {
                try {
                  const result = this.toolExecutor
                    ? await this.toolExecutor(fc.name, fc.args || {})
                    : { error: 'No tool executor configured' };

                  if (result && result.floyd_command) {
                    this.onMessage(`[Tom -> Floyd] Executing: ${result.floyd_command}`);
                  }

                  functionResponses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { result: JSON.stringify(result) },
                  });
                } catch (err) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  functionResponses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { error: errMsg },
                  });
                }
              }

              sessionPromise
                .then((session) => {
                  if (this.state === 'connected' && session) {
                    try {
                      session.sendToolResponse({ functionResponses });
                      this._consecutiveSendErrors = 0;
                    } catch (err) {
                      this._handleSendError(err, 'tool response');
                    }
                  }
                }).catch(() => {});
              return;
            }

            const parts = message.serverContent?.modelTurn?.parts ?? [];
            for (const part of parts) {
              if (part.thought) continue;
              if (part.inlineData?.data) {
                if (Date.now() >= this.suppressOutputUntilMs) {
                  this.playAudioChunk(part.inlineData.data);
                  this.onAudioData(part.inlineData.data);
                }
              } else if (part.text) {
                this.onMessage(part.text);
                this.handleMemoryCheckpoint(part.text);
              }
            }
          },
          onclose: (event) => {
            if (!this.isIntentionalDisconnect && this.state === 'connected') {
              this.attemptReconnect();
            } else if (this.state !== 'idle') {
              this.state = 'idle';
              this.onStatusChange?.(this.state);
            }
          },
          onerror: (err) => {
            if (this.isIntentionalDisconnect || this.state === 'disconnecting') {
              this.state = 'idle';
              this.onStatusChange?.(this.state);
              return;
            }
            const errorMessage = err instanceof Error ? err.message : String(err);
            this.onError?.({ type: 'api_error', message: errorMessage });

            if (this.state === 'connected') {
              this.attemptReconnect();
            } else {
              this.state = 'idle';
              this.onStatusChange?.(this.state);
            }
          },
        },
      });

      this.activeSession = sessionPromise;
      return sessionPromise;
    } catch (err) {
      if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        this.onError?.({ type: 'permission_denied', device: 'microphone' });
      } else {
        this.onError?.({ type: 'api_error', message: err instanceof Error ? err.message : 'Connection failed' });
      }
      this.state = 'idle';
      this.onStatusChange?.(this.state);
      throw err;
    }
  }

  _handleSendError(err, type) {
    if (this.state !== 'connected') return;
    this._consecutiveSendErrors++;
    console.warn(`Failed to send ${type} (${this._consecutiveSendErrors}/${this._maxConsecutiveErrors}):`, err);

    // Secret Sauce 2: Dynamic Load Shedding
    if (this._consecutiveSendErrors === 2) {
      console.warn("[Floyd Live] Socket struggling. Shedding video bandwidth to LOW mode.");
      this._adaptiveMode = 'LOW';
      this._lastModeSwitch = Date.now() + 10000; // Lock in LOW for 10 seconds
    }

    if (this._consecutiveSendErrors >= this._maxConsecutiveErrors) {
      console.error("[Circuit Breaker] Tripped! Socket wedged. Forcing reconnect.");
      this._consecutiveSendErrors = 0;
      this.attemptReconnect();
    }
  }

  async attemptReconnect() {
    if (this.isIntentionalDisconnect || this.state === 'disconnecting' || this.state === 'idle') return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.onError?.({
        type: 'network_error',
        retrying: false,
        attempt: this.reconnectAttempts,
        message: 'Connection lost. Please try again.',
      });
      this.disconnect();
      return;
    }

    this.state = 'reconnecting';
    this.onStatusChange?.(this.state);

    const delay = Math.min(this.reconnectDelay * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts++;

    this.reconnectTimeout = window.setTimeout(async () => {
      if (this.isIntentionalDisconnect || this.state === 'disconnecting' || this.state === 'idle') return;
      try {
        await this.connect(this.stream || undefined);
      } catch (err) {
        if (!this.isIntentionalDisconnect) console.error('Reconnection failed:', err);
      }
    }, delay);
  }

  async initAudioInput(stream, sessionPromise) {
    if (!this.inputAudioContext) return;
    if (this.inputAudioContext.audioWorklet) {
      try {
        await this.startAudioInputModern(stream, sessionPromise);
        return;
      } catch (err) {
        console.warn('AudioWorklet failed, falling back to ScriptProcessor:', err);
      }
    }
    this.startAudioInputLegacy(stream, sessionPromise);
  }

  _processAudioInput(pcmData, sessionPromise) {
    if (this.state !== 'connected' || this.abortController?.signal.aborted) return;

    // Secret Sauce 1: Audio Batching to prevent 429 errors and socket wedging.
    // Natively, Worklets fire every 8ms. We batch to 4096 samples (~256ms) before sending.
    if (!this._audioBuffer) this._audioBuffer = [];
    for (let i = 0; i < pcmData.length; i++) {
      this._audioBuffer.push(pcmData[i]);
    }

    if (this._audioBuffer.length < 4096) return;

    const chunkToProcess = new Int16Array(this._audioBuffer);
    this._audioBuffer = []; // Reset buffer for the next batch

    // Calculate RMS on the batched chunk
    let sum = 0;
    for (let i = 0; i < chunkToProcess.length; i++) {
      const s = chunkToProcess[i] / 32768;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / chunkToProcess.length);

    const isAIActive = this.isSpeakingOrRecently(this.echoTailMs);
    const threshold = isAIActive ? this.echoRejectThreshold : this.silenceThreshold;

    if (rms >= threshold) {
      if (isAIActive) {
        this.interrupt({ suppressMs: 800 });
      }

      const bytes = new Uint8Array(chunkToProcess.buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64Data = btoa(binary);

      sessionPromise.then((session) => {
        if (this.state === 'connected' && session) {
          try {
            session.sendRealtimeInput({
              media: { mimeType: 'audio/pcm;rate=16000', data: base64Data },
            });
            this._consecutiveSendErrors = 0;
          } catch (err) {
            this._handleSendError(err, 'audio');
          }
        }
      }).catch(() => {});
    }
  }

  async startAudioInputModern(stream, sessionPromise) {
    const inputCtx = this.inputAudioContext;
    if (!inputCtx) return;

    await inputCtx.audioWorklet.addModule(chrome.runtime.getURL('audio/pcm-processor.worklet.js'));
    this.inputSource = inputCtx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(inputCtx, 'pcm-processor');

    this.workletNode.port.onmessage = (e) => {
      this._processAudioInput(e.data.pcmData, sessionPromise);
    };
    this.inputSource.connect(this.workletNode);
  }

  startAudioInputLegacy(stream, sessionPromise) {
    if (!this.inputAudioContext) return;

    this.inputSource = this.inputAudioContext.createMediaStreamSource(stream);
    this.processor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const pcmData = this.float32ToInt16(inputData);
      this._processAudioInput(pcmData, sessionPromise);
    };

    this.inputSource.connect(this.processor);
    this.processor.connect(this.inputAudioContext.destination);
  }

  async playAudioChunk(base64) {
    if (!this.outputAudioContext || !this.outputNode || this.state !== 'connected') return;
    if (Date.now() < this.suppressOutputUntilMs) return;

    try {
      const binaryString = atob(base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);

      const audioBuffer = await this.decodePCM(bytes, this.outputAudioContext);

      const currentTime = this.outputAudioContext.currentTime;
      if (this.nextStartTime < currentTime) this.nextStartTime = currentTime;

      const source = this.outputAudioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.outputNode);
      source.start(this.nextStartTime);

      this.lastOutputAtMs = Date.now();
      this.nextStartTime += audioBuffer.duration;

      source.onended = () => this.sources.delete(source);
      this.sources.add(source);
    } catch (err) {
      console.error('Error playing audio chunk:', err);
    }
  }

  async decodePCM(data, ctx) {
    const int16Data = new Int16Array(data.buffer);
    const float32Data = new Float32Array(int16Data.length);
    for (let i = 0; i < int16Data.length; i++) float32Data[i] = int16Data[i] / 32768.0;

    const buffer = ctx.createBuffer(1, float32Data.length, 24000);
    buffer.getChannelData(0).set(float32Data);
    return buffer;
  }

  float32ToInt16(float32) {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
  }

  async handleMemoryCheckpoint(modelText) {
    this.transcriptBuffer.push(`Assistant: ${modelText}`);
    if (this.transcriptBuffer.length >= 2) {
      this.transcriptBuffer = this.transcriptBuffer.slice(-2);
    }
  }

  _computeFrameDiff() {
    if (!this._diffCtx || !this._diffCanvas || !this.videoElement) return 50;

    this._diffCtx.drawImage(this.videoElement, 0, 0, this._diffCanvas.width, this._diffCanvas.height);
    const imgData = this._diffCtx.getImageData(0, 0, this._diffCanvas.width, this._diffCanvas.height);
    const current = imgData.data;

    if (!this._prevDiffData) {
      this._prevDiffData = new Uint8ClampedArray(current);
      return 50;
    }

    const prev = this._prevDiffData;
    const totalPixels = this._diffCanvas.width * this._diffCanvas.height;
    let changed = 0;
    let sampled = 0;

    for (let i = 0; i < totalPixels; i += ADAPTIVE_PIXEL_SAMPLE_STEP) {
      const off = i * 4;
      sampled++;
      if (
        Math.abs(current[off] - prev[off]) > ADAPTIVE_PIXEL_THRESHOLD ||
        Math.abs(current[off + 1] - prev[off + 1]) > ADAPTIVE_PIXEL_THRESHOLD ||
        Math.abs(current[off + 2] - prev[off + 2]) > ADAPTIVE_PIXEL_THRESHOLD
      ) {
        changed++;
      }
    }

    this._prevDiffData = new Uint8ClampedArray(current);
    return sampled > 0 ? (changed / sampled) * 100 : 0;
  }

  _resolveAdaptiveParams(diffPercent) {
    let target = diffPercent > 15 ? 'HIGH' : diffPercent >= 5 ? 'MEDIUM' : 'LOW';
    const now = Date.now();

    if (target !== this._adaptiveMode && now - this._lastModeSwitch >= ADAPTIVE_MODE_COOLDOWN_MS) {
      this._adaptiveMode = target;
      this._lastModeSwitch = now;
    }
    return ADAPTIVE_PROFILES[this._adaptiveMode];
  }

  startVideoStream(stream) {
    if (this.state !== 'connected' || !this.activeSession) return;
    this.videoStream = stream;

    this.videoElement = document.createElement('video');
    this.videoElement.srcObject = stream;
    this.videoElement.autoplay = true;
    this.videoElement.play();
    this.videoElement.muted = true;

    this.canvasElement = document.createElement('canvas');
    const ctx = this.canvasElement.getContext('2d');
    if (!ctx) return;

    this._diffCanvas = document.createElement('canvas');
    this._diffCanvas.width = ADAPTIVE_DIFF_W;
    this._diffCanvas.height = ADAPTIVE_DIFF_H;
    this._diffCtx = this._diffCanvas.getContext('2d');
    this._prevDiffData = null;
    this._adaptiveMode = 'MEDIUM';
    this._lastModeSwitch = 0;

    const captureFrame = () => {
      if (!this.videoElement || !this.canvasElement || !ctx || this.state !== 'connected') return;

      if (this.videoElement.readyState >= this.videoElement.HAVE_ENOUGH_DATA) {
        const diffPercent = this._computeFrameDiff();
        const params = this._resolveAdaptiveParams(diffPercent);

        const maxW = params.maxWidth;
        let w = this.videoElement.videoWidth;
        let h = this.videoElement.videoHeight;
        if (w > maxW) {
          h = Math.round(h * (maxW / w));
          w = maxW;
        }
        this.canvasElement.width = w;
        this.canvasElement.height = h;
        ctx.drawImage(this.videoElement, 0, 0, w, h);

        const base64Data = this.canvasElement.toDataURL('image/jpeg', params.quality).split(',')[1];

        this.activeSession
          .then((session) => {
            if (this.state === 'connected' && session) {
              try {
                session.sendRealtimeInput({
                  media: { mimeType: 'image/jpeg', data: base64Data },
                });
                this._consecutiveSendErrors = 0;
              } catch (err) {
                this._handleSendError(err, 'video frame');
              }
            }
          }).catch(() => {});

        this._videoTimeout = window.setTimeout(captureFrame, params.intervalMs);
      } else {
        this._videoTimeout = window.setTimeout(captureFrame, ADAPTIVE_PROFILES.MEDIUM.intervalMs);
      }
    };

    this._videoTimeout = window.setTimeout(captureFrame, 100);
  }

  stopVideoStream() {
    if (this.videoInterval) clearInterval(this.videoInterval);
    if (this._videoTimeout) clearTimeout(this._videoTimeout);
    if (this.videoStream) this.videoStream.getTracks().forEach((track) => track.stop());

    this.videoInterval = null;
    this._videoTimeout = null;
    this.videoStream = null;
    this.videoElement = null;
    this.canvasElement = null;
    this._prevDiffData = null;
    this._diffCanvas = null;
    this._diffCtx = null;
    this._adaptiveMode = 'MEDIUM';
  }

  disconnect() {
    this.isIntentionalDisconnect = true;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

    this.reconnectAttempts = 0;
    this._consecutiveSendErrors = 0;
    this.abortController?.abort();

    if (this.state !== 'idle' && this.state !== 'disconnecting') {
      this.state = 'disconnecting';
      this.onStatusChange?.(this.state);
    }

    this.stopVideoStream();
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);

    this.sources.forEach((s) => { try { s.stop(); } catch (_) {} });
    this.sources.clear();

    if (this.workletNode) this.workletNode.disconnect();
    if (this.processor) this.processor.disconnect();
    if (this.inputSource) this.inputSource.disconnect();

    this.workletNode = null;
    this.processor = null;
    this.inputSource = null;

    if (this.inputAudioContext) this.inputAudioContext.close().catch(() => {});
    if (this.outputAudioContext) this.outputAudioContext.close().catch(() => {});

    this.inputAudioContext = null;
    this.outputAudioContext = null;

    if (this.activeSession) {
      this.activeSession.then((s) => { try { s.close?.(); } catch (_) {} }).catch(() => {});
      this.activeSession = null;
    }

    this.state = 'idle';
    this.isIntentionalDisconnect = false;
    this.reconnectAttempts = 0;
    this.onStatusChange?.(this.state);
  }
}

export { LiveSession, ADAPTIVE_PROFILES };