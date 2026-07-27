/**
 * Voice input — push-to-talk speech capture into the terminal input line.
 *
 * Captures a short utterance with getUserMedia + MediaRecorder, sends it over
 * the existing JSON WebSocket as bounded base64 chunks, then injects the final
 * server transcript exactly once through T1.sendData(). It never sends Enter.
 */
const MAX_RECORDING_MS = 20_000;
const DANGEROUS_COMMAND_RE = /\b(rm\s+-rf|mkfs|dd\s+if=|:\(\)\s*\{|diskutil\s+erase|shutdown|reboot)\b/i;

export function init(T1) {
  T1.ui.addStyle(`
    .t1voice-button.listening,
    .t1voice-key.listening {
      background: #f7768e;
      color: #1a1b26;
      border-color: #f7768e;
    }
    .t1voice-button.transcribing,
    .t1voice-key.transcribing {
      background: #e0af68;
      color: #1a1b26;
      border-color: #e0af68;
    }
    .t1voice-key {
      min-width: 64px;
    }
  `);

  let recorder = null;
  let stream = null;
  let state = 'idle';
  let stopTimer = 0;
  let pendingChunks = Promise.resolve();
  const buttons = new Set();

  function supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && window.isSecureContext);
  }

  function wsOpen() {
    const sock = T1.ws;
    return sock && sock.readyState === WebSocket.OPEN ? sock : null;
  }

  function setState(next) {
    state = next;
    for (const button of buttons) {
      button.classList.toggle('listening', state === 'recording');
      button.classList.toggle('transcribing', state === 'transcribing');
      button.disabled = state === 'transcribing' || !supported();
      button.setAttribute('aria-pressed', state === 'recording' ? 'true' : 'false');
      button.textContent = state === 'recording' ? 'Stop' : state === 'transcribing' ? 'Wait' : 'Voice';
      button.title = supported() ? 'Voice input' : 'Voice input requires HTTPS/localhost and MediaRecorder';
    }
  }

  function pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus'
    ];
    for (const type of candidates) {
      try {
        if (MediaRecorder.isTypeSupported?.(type)) return type;
      } catch (_) {}
    }
    return '';
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const stride = 0x8000;
    for (let i = 0; i < bytes.length; i += stride) {
      binary += String.fromCharCode(...bytes.subarray(i, i + stride));
    }
    return btoa(binary);
  }

  function normalizeTranscript(text) {
    return String(text || '')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\s+([|/.-])/g, '$1')
      .replace(/\bpipe\b/gi, '|')
      .replace(/\bslash\b/gi, '/')
      .replace(/\bdash dash\b/gi, '--')
      .replace(/\bdot\b/gi, '.')
      .replace(/[.!?]+$/g, '');
  }

  function sendJson(payload) {
    const sock = wsOpen();
    if (!sock) {
      T1.toast('Voice input needs an active terminal connection', 'warn');
      return false;
    }
    sock.send(JSON.stringify(payload));
    return true;
  }

  async function sendBlob(blob) {
    if (!blob || blob.size === 0) return;
    const b64 = arrayBufferToBase64(await blob.arrayBuffer());
    sendJson({ type: 'voice-chunk', b64 });
  }

  function cleanupRecording() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = 0;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    stream = null;
    recorder = null;
  }

  async function start() {
    if (state !== 'idle') return;
    if (!supported()) {
      T1.toast('Voice input requires HTTPS/localhost and MediaRecorder support', 'warn');
      setState('idle');
      return;
    }
    let serverVoiceStarted = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
      const mimeType = pickMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      if (!sendJson({ type: 'voice-start', mimeType: recorder.mimeType || mimeType })) {
        cleanupRecording();
        return;
      }
      serverVoiceStarted = true;
      pendingChunks = Promise.resolve();
      recorder.addEventListener('dataavailable', (event) => {
        pendingChunks = pendingChunks.then(() => sendBlob(event.data)).catch((err) => {
          T1.toast(`Voice chunk failed: ${err.message || err}`, 'error');
        });
      });
      recorder.addEventListener('stop', async () => {
        setState('transcribing');
        await pendingChunks;
        sendJson({ type: 'voice-end' });
        cleanupRecording();
      }, { once: true });
      recorder.start(500);
      setState('recording');
      stopTimer = setTimeout(() => stop(), MAX_RECORDING_MS);
    } catch (err) {
      if (serverVoiceStarted) sendJson({ type: 'voice-end' });
      cleanupRecording();
      setState('idle');
      T1.toast(`Microphone unavailable: ${err.message || err}`, 'error');
    }
  }

  function stop() {
    if (state !== 'recording' || !recorder) return;
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = 0;
    }
    try { recorder.stop(); }
    catch (err) {
      cleanupRecording();
      setState('idle');
      T1.toast(`Voice stop failed: ${err.message || err}`, 'error');
    }
  }

  function toggle() {
    if (state === 'recording') stop();
    else if (state === 'idle') start();
  }

  function registerButton(button) {
    if (!button || buttons.has(button)) return button;
    buttons.add(button);
    button.addEventListener('click', toggle);
    setState(state);
    return button;
  }

  const toolbar = T1.ui.toolbar();
  if (toolbar) {
    const button = T1.ui.makeButton('Voice', 'Voice input');
    button.classList.add('t1voice-button');
    button.setAttribute('aria-pressed', 'false');
    toolbar.appendChild(registerButton(button));
  }

  function ensureKeybarButtons() {
    for (const button of Array.from(buttons)) {
      if (!button.isConnected) buttons.delete(button);
    }
    const device = T1.device;
    const ids = device === 'iphone' ? ['keybarIphone'] : device === 'ipad' ? ['keybarIpad'] : [];
    for (const id of ids) {
      const bar = document.getElementById(id);
      if (!bar || bar.querySelector('.t1voice-key')) continue;
      const group = document.createElement('div');
      group.className = 'kb-group t1voice-group';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'kb-key t1voice-key';
      group.appendChild(registerButton(button));
      bar.appendChild(group);
    }
  }
  ensureKeybarButtons();
  window.addEventListener('orientationchange', () => setTimeout(ensureKeybarButtons, 250));

  window.addEventListener('t1:voice-transcript', (event) => {
    const text = normalizeTranscript(event.detail?.text);
    setState('idle');
    if (!text) {
      T1.toast('No speech detected', 'warn');
      return;
    }
    if (DANGEROUS_COMMAND_RE.test(text) && !confirm(`Insert potentially dangerous command?\n\n${text}`)) {
      T1.toast('Voice command discarded', 'warn');
      return;
    }
    T1.sendData(text);
    T1.toast('Voice transcript inserted');
  });

  window.addEventListener('t1:voice-error', (event) => {
    setState('idle');
    const code = event.detail?.code || 'VOICE_ERROR';
    const message = event.detail?.message || 'Voice input failed';
    T1.toast(`${code}: ${message}`, 'error');
  });

  window.__terminalOneVoiceInput = { start, stop, toggle, supported, normalizeTranscript };
}
