/**
 * InputGuard — eliminate iOS/iPadOS dictate-to-text and IME echo duplication
 * while keeping normal typing perfectly crisp.
 *
 * v2 design (rolling buffer):
 *  - Single characters are sent immediately and APPEND to a rolling buffer of
 *    recently-sent text. (v1 reset the baseline on single chars — this was the
 *    dictation-doubling bug: a single-char event between the last partial and
 *    the compositionend finalization zeroed the baseline, so the full phrase
 *    was re-sent in its entirety.)
 *  - Multi-character strings are compared against the FULL rolling buffer, not
 *    just the last event. This catches all dictation patterns:
 *      • Cumulative partials ("a" → "ab" → "abc") — suffix delta sent.
 *      • Finalization re-fire of the complete phrase — suppressed (already in
 *        buffer).
 *      • Word-by-word partials followed by full-phrase finalization — the
 *        accumulated buffer contains the full phrase, so finalization is
 *        suppressed.
 *  - Control sequences reset the buffer and are sent immediately.
 *  - The rolling buffer is capped (default 256 chars) and entries expire after
 *    `bufferDedupeMs` (default 3000ms) so legitimate paste/type of previously
 *    sent text is not suppressed after a few seconds.
 */
export class InputGuard {
  constructor({ send, identicalDedupeMs = 500, bufferSize = 256, bufferDedupeMs = 3000 }) {
    this._send = send;
    this.identicalDedupeMs = identicalDedupeMs;
    this._bufferSize = bufferSize;
    this._bufferDedupeMs = bufferDedupeMs;
    this._sentBuffer = '';
    this._bufferTime = 0;
    this._lastEvent = { data: '', time: 0 };
    this._now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  onData(data) {
    if (!data || data.length === 0) return;

    const now = this._now();

    // Drop exact duplicate events that xterm.js / iOS sometimes fires twice
    // for one physical input. Never deduplicates single characters (normal
    // typing must stay crisp).
    if (data.length > 1 && data === this._lastEvent.data && now - this._lastEvent.time < this.identicalDedupeMs) {
      return;
    }
    this._lastEvent = { data, time: now };

    const printable = [...data].every((c) => c.charCodeAt(0) >= 0x20);

    // Non-printable (control sequences, Enter, arrows, etc.) → send + reset.
    if (!printable) {
      this._sendRaw(data);
      this._resetBuffer();
      return;
    }

    // Single character → always send immediately, APPEND to buffer (do NOT
    // reset — this is the v1 bug fix).
    if (data.length === 1) {
      this._sendRaw(data);
      this._appendBuffer(data);
      return;
    }

    // Multi-char: compare against the full rolling buffer so that dictation
    // finalization (compositionend re-firing the complete phrase) is suppressed
    // even when single chars or word-level partials were sent in between.

    const bufferFresh = this._sentBuffer && now - this._bufferTime < this._bufferDedupeMs;

    // Case 1: data is entirely contained in recent buffer → already sent.
    if (bufferFresh && this._sentBuffer.includes(data)) {
      return;
    }

    // Case 2: buffer is a prefix of data → send only the suffix (cumulative
    // partial extension: "hello" → "hello world").
    if (bufferFresh && data.startsWith(this._sentBuffer)) {
      const delta = data.slice(this._sentBuffer.length);
      this._sendRaw(delta);
      this._sentBuffer = data.slice(-this._bufferSize);
      this._bufferTime = now;
      return;
    }

    // Case 3: data overlaps the tail of the buffer → send only the new suffix
    // (suffix revision: "hello world" → "world peace").
    if (bufferFresh) {
      const overlap = this._longestTailOverlap(this._sentBuffer, data);
      if (overlap > 0) {
        const delta = data.slice(overlap);
        if (delta.length === 0) return; // fully overlapped → already sent
        this._sendRaw(delta);
        this._appendBuffer(delta);
        this._bufferTime = now;
        return;
      }
    }

    // Case 4: No overlap with recent history → send full data.
    this._sendRaw(data);
    this._appendBuffer(data);
    this._bufferTime = now;
  }

  /** Raw send for deliberate key-bar input (Enter, arrows, etc.). Resets the
   *  buffer so the next dictation starts clean. */
  send(data) {
    this._sendRaw(data);
    this._resetBuffer();
  }

  dispose() {
    /* no timers to clear */
  }

  _appendBuffer(text) {
    this._sentBuffer = (this._sentBuffer + text).slice(-this._bufferSize);
  }

  _resetBuffer() {
    this._sentBuffer = '';
    this._bufferTime = 0;
  }

  /** Longest suffix of `buffer` that is also a prefix of `data`. */
  _longestTailOverlap(buffer, data) {
    const max = Math.min(buffer.length, data.length);
    for (let len = max; len > 0; len -= 1) {
      if (buffer.endsWith(data.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  _sendRaw(data) {
    if (data) this._send(data);
  }
}
