/**
 * Event Streamer — Content script that hooks into dom-observer.js
 * and streams batched DOM events to background.js for the Perception Engine.
 *
 * Loads after dom-observer.js. Hooks via window.__anvilStreamEvent.
 * Batches events every 100ms (max 50/batch) and sends to background.
 */
(function () {
  'use strict';

  const EVENT_STREAMER_VERSION = '1.1.0';

  // ─── Configuration ───────────────────────────────────────────────────────
  const BATCH_INTERVAL_MS = 100;
  const MAX_EVENTS_PER_BATCH = 50;

  // ─── State ───────────────────────────────────────────────────────────────
  let _eventBuffer = [];
  let _batchTimer = null;
  let _streamActive = false;

  // ─── Batching ────────────────────────────────────────────────────────────

  function _flushBatch() {
    if (_eventBuffer.length === 0) return;

    const batch = _eventBuffer.splice(0, MAX_EVENTS_PER_BATCH);

    try {
      chrome.runtime.sendMessage({
        type: 'perception_events',
        events: batch,
        tabUrl: window.location.href,
        timestamp: Date.now()
      });
    } catch (e) {
      // Extension context invalidated — stop streaming
      _stopStreaming();
    }
  }

  function _startStreaming() {
    if (_streamActive) return;
    _streamActive = true;
    _batchTimer = setInterval(_flushBatch, BATCH_INTERVAL_MS);
  }

  function _stopStreaming() {
    _streamActive = false;
    if (_batchTimer) {
      clearInterval(_batchTimer);
      _batchTimer = null;
    }
    _eventBuffer = [];
  }

  // ─── Hook for dom-observer.js ────────────────────────────────────────────

  window.__anvilStreamEvent = function (delta) {
    if (!_streamActive) _startStreaming();
    _eventBuffer.push(delta);

    // Overflow protection: drop oldest if buffer grows too large
    if (_eventBuffer.length > MAX_EVENTS_PER_BATCH * 4) {
      _eventBuffer = _eventBuffer.slice(-MAX_EVENTS_PER_BATCH * 2);
    }
  };

  // ─── Snapshot on Load ────────────────────────────────────────────────────

  function _sendSnapshot() {
    // Build a lightweight snapshot from the accessibility tree if available
    const nodes = [];
    const refMap = window.__anvilRefMap;

    if (refMap && typeof refMap.entries === 'function') {
      for (const [ref, element] of refMap.entries()) {
        if (nodes.length >= 5000) break;
        if (!element || element.nodeType !== Node.ELEMENT_NODE) continue;

        nodes.push({
          ref,
          tagName: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          textContent: (element.textContent || '').trim().substring(0, 100),
          attributes: _getKeyAttributes(element)
        });
      }
    }

    try {
      chrome.runtime.sendMessage({
        type: 'perception_snapshot',
        url: window.location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        scroll: {
          x: window.scrollX,
          y: window.scrollY
        },
        readyState: document.readyState,
        nodes,
        timestamp: Date.now()
      });
    } catch (e) {
      // Extension context invalidated
    }
  }

  function _getKeyAttributes(element) {
    const attrs = {};
    const interesting = ['id', 'class', 'name', 'type', 'href', 'src', 'placeholder',
                          'aria-label', 'aria-expanded', 'aria-hidden', 'disabled',
                          'value', 'checked', 'selected', 'tabindex', 'alt', 'title'];
    for (const attr of interesting) {
      if (element.hasAttribute(attr)) {
        const val = element.getAttribute(attr);
        if (val !== null && val !== '') {
          attrs[attr] = val.substring(0, 100);
        }
      }
    }
    return attrs;
  }

  // ─── Scroll Tracking ────────────────────────────────────────────────────

  let _scrollTimer = null;
  function _onScroll() {
    // Debounce scroll events to 250ms
    if (_scrollTimer) clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({
          type: 'perception_scroll',
          x: window.scrollX,
          y: window.scrollY,
          timestamp: Date.now()
        });
      } catch (e) {
        // Extension context invalidated
      }
    }, 250);
  }

  // ─── Message Listener (for on-demand snapshots) ──────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'perception_request_snapshot') {
      _sendSnapshot();
      sendResponse({ success: true });
      return false;
    }
    return false;
  });

  // ─── Initialize ──────────────────────────────────────────────────────────

  function _init() {
    _startStreaming();
    window.addEventListener('scroll', _onScroll, { passive: true });

    // Send initial snapshot after the page settles
    if (document.readyState === 'complete') {
      setTimeout(_sendSnapshot, 100);
    } else {
      window.addEventListener('load', () => setTimeout(_sendSnapshot, 100), { once: true });
    }
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }
})();
