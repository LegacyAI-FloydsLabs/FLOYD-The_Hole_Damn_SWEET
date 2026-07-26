/**
 * DOM Change Observer — Structured delta tracking between agent steps.
 *
 * Starts a MutationObserver that records structured change deltas (added,
 * removed, attribute_changed, text_changed) into a capped ring buffer.
 * The agent calls getDomChanges() to drain the buffer between steps.
 *
 * This observer is intentionally separate from the existing MutationObserver
 * in content-script.js which handles coarse dom_mutation system events.
 */
(function () {
  'use strict';

  // =========================================================================
  // Module State
  // =========================================================================
  const _DOM_CHANGES_MAX = 500;
  let _domChanges = [];
  let _observer = null;

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Check whether a node (or any ancestor) is an extension-injected element.
   * Extension elements carry `data-anvil-injected` or live inside a Shadow DOM
   * host created by agent-indicator.js.
   */
  function _isExtensionElement(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      // For text/characterData nodes, check the parentElement
      if (node && node.parentElement) {
        return _isExtensionElement(node.parentElement);
      }
      return false;
    }

    let el = node;
    while (el) {
      // Direct attribute check
      if (el.hasAttribute && el.hasAttribute('data-anvil-injected')) return true;

      // Shadow DOM host check — agent-indicator attaches a shadowRoot
      if (el.shadowRoot) return true;

      // If we've walked into a ShadowRoot, the host is the extension element
      if (el.getRootNode && el.getRootNode() instanceof ShadowRoot) return true;

      el = el.parentElement;
    }
    return false;
  }

  /**
   * Look up the Anvil ref ID (ref_N) for an element, if one was assigned
   * by accessibility-tree.js.
   */
  function _getRefId(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return undefined;
    const reverseMap = window.__anvilElementReverseMap;
    if (reverseMap && typeof reverseMap.get === 'function') {
      const ref = reverseMap.get(element);
      if (ref) return ref;
    }
    return undefined;
  }

  /** Truncate a string to `max` characters. */
  function _truncate(str, max) {
    if (typeof str !== 'string') return '';
    return str.length > max ? str.substring(0, max) : str;
  }

  /** Push a delta, respecting the cap. */
  function _pushChange(delta) {
    if (_domChanges.length >= _DOM_CHANGES_MAX) {
      _domChanges.shift();
    }
    _domChanges.push(delta);
    // Stream to perception engine via event-streamer.js
    if (typeof window.__anvilStreamEvent === 'function') window.__anvilStreamEvent(delta);
  }

  // =========================================================================
  // Mutation Callback
  // =========================================================================

  function _handleMutations(mutations) {
    for (const mutation of mutations) {

      // --- Filter: skip extension-injected elements ---
      if (_isExtensionElement(mutation.target)) continue;

      switch (mutation.type) {

        case 'childList': {
          // Added nodes
          for (const addedNode of mutation.addedNodes) {
            if (addedNode.nodeType !== Node.ELEMENT_NODE) continue;
            if (_isExtensionElement(addedNode)) continue;

            _pushChange({
              type: 'added',
              tagName: addedNode.tagName.toLowerCase(),
              role: (addedNode.getAttribute && addedNode.getAttribute('role')) || '',
              textContent: _truncate((addedNode.textContent || '').trim(), 100),
              ref: _getRefId(addedNode)
            });
          }

          // Removed nodes
          for (const removedNode of mutation.removedNodes) {
            if (removedNode.nodeType !== Node.ELEMENT_NODE) continue;
            if (_isExtensionElement(removedNode)) continue;

            _pushChange({
              type: 'removed',
              tagName: removedNode.tagName.toLowerCase(),
              role: (removedNode.getAttribute && removedNode.getAttribute('role')) || '',
              textContent: _truncate((removedNode.textContent || '').trim(), 100)
            });
          }
          break;
        }

        case 'attributes': {
          // Filter: skip style-only attribute changes
          if (mutation.attributeName === 'style') continue;

          const attrTarget = mutation.target;
          if (attrTarget.nodeType !== Node.ELEMENT_NODE) continue;

          _pushChange({
            type: 'attribute_changed',
            tagName: attrTarget.tagName.toLowerCase(),
            attribute: mutation.attributeName,
            oldValue: mutation.oldValue,
            newValue: attrTarget.getAttribute
              ? attrTarget.getAttribute(mutation.attributeName)
              : null,
            ref: _getRefId(attrTarget)
          });
          break;
        }

        case 'characterData': {
          const textTarget = mutation.target;
          const parentEl = textTarget.parentElement;
          if (!parentEl) continue;
          if (_isExtensionElement(parentEl)) continue;

          _pushChange({
            type: 'text_changed',
            tagName: parentEl.tagName.toLowerCase(),
            oldValue: _truncate(mutation.oldValue || '', 100),
            newValue: _truncate((textTarget.textContent || '').trim(), 100),
            ref: _getRefId(parentEl)
          });
          break;
        }
      }
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Start the DOM change observer on document.body.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  function initDomObserver() {
    if (_observer) return;
    if (!document.body) return;

    _observer = new MutationObserver(_handleMutations);
    _observer.observe(document.body, {
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
      subtree: true
    });
  }

  /**
   * Return accumulated DOM changes since the last call, then reset the buffer.
   * @param {object} [args] - Reserved for future filtering options.
   * @returns {{success: boolean, changes: Array, count: number}}
   */
  function getDomChanges(args) {
    const changes = _domChanges;
    const count = changes.length;
    _domChanges = [];
    return { success: true, changes: changes, count: count };
  }

  // Expose on window for content-script.js integration
  window.initDomObserver = initDomObserver;
  window.getDomChanges = getDomChanges;
})();

// INTEGRATION: Add to content-script.js: case 'get_dom_changes': return getDomChanges(args);
// INTEGRATION: Call initDomObserver() in content-script.js DOMContentLoaded or at script load
