// offscreen.js — Floyd's Labs TTY Bridge v4.2
// Offscreen document for audio playback (Gemini Live output), WASM execution, and GIF recording.
// Runs in a hidden document context that can play audio without restrictions.
'use strict';

const AudioCtx = window.AudioContext || window.webkitAudioContext;
const audioContext = new AudioCtx();
let wasmLoaderPromise;
let gifRecorderPromise;

function getWasmLoaderImportPath() {
  const inChromeExtension = typeof location !== 'undefined' && location.protocol === 'chrome-extension:';

  if (inChromeExtension && typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
    return chrome.runtime.getURL('wasm/sha256-loader.js');
  }

  return './wasm/sha256-loader.js';
}

async function getWasmLoader() {
  if (!wasmLoaderPromise) {
    wasmLoaderPromise = import(getWasmLoaderImportPath());
  }

  return wasmLoaderPromise;
}

function getGifRecorderImportPath() {
  const inChromeExtension = typeof location !== 'undefined' && location.protocol === 'chrome-extension:';

  if (inChromeExtension && typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
    return chrome.runtime.getURL('gif-recorder.js');
  }

  return './gif-recorder.js';
}

async function getGifRecorder() {
  if (!gifRecorderPromise) {
    gifRecorderPromise = import(getGifRecorderImportPath());
  }

  return gifRecorderPromise;
}

async function handleGifCommand(data) {
  const recorder = await getGifRecorder();
  const command = data && data.command;

  switch (command) {
    case 'gif_start':
      return recorder.gifStart();

    case 'gif_add_frame':
      return recorder.gifAddFrame(data);

    case 'gif_stop':
      return recorder.gifStop(data);

    default:
      throw new Error(`Unknown GIF command: ${command}`);
  }
}

async function executeWasmModule(data) {
  const startTime = performance.now();
  const moduleName = data && data.module;
  const loader = await getWasmLoader();

  switch (moduleName) {
    case 'hash': {
      const result = await loader.computeSHA256(data ? data.input : '');
      return {
        success: true,
        module: 'hash',
        result,
        executionTimeMs: Number((performance.now() - startTime).toFixed(2))
      };
    }

    default:
      throw new Error(`Unsupported WASM module: ${moduleName}`);
  }
}

async function playPcmAudio(base64Data, sampleRate) {
  try {
    const raw = atob(base64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    // 16-bit PCM LE mono
    const samples = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) float32[i] = samples[i] / 32768;

    const buffer = audioContext.createBuffer(1, float32.length, sampleRate || 24000);
    buffer.getChannelData(0).set(float32);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    if (audioContext.state === 'suspended') await audioContext.resume();

    source.start(0);

    return new Promise((resolve, reject) => {
      source.onended = () => resolve();
      source.onerror = (e) => reject(e);
    });
  } catch (err) {
    console.error('[Floyd Offscreen] PCM playback error:', err);
    throw err;
  }
}

async function playAudioUrl(url, volume) {
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;

    const gainNode = audioContext.createGain();
    gainNode.gain.value = volume || 1.0;
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);

    if (audioContext.state === 'suspended') await audioContext.resume();

    source.start(0);

    return new Promise((resolve, reject) => {
      source.onended = () => resolve();
      source.onerror = (e) => reject(e);
    });
  } catch (err) {
    console.error('[Floyd Offscreen] URL playback error:', err);
    throw err;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'PLAY_PCM_AUDIO':
      playPcmAudio(message.data, message.sampleRate)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'PLAY_AUDIO_URL':
      playAudioUrl(message.url, message.volume)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'GENERATE_GIF':
      handleGifCommand(message.data)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'WASM_EXECUTE':
      executeWasmModule(message.data)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    default:
      sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
      return true;
  }
});

// INTEGRATION: Add to manifest.json: "content_security_policy": {"extension_pages": "script-src 'self' 'wasm-unsafe-eval'"}
