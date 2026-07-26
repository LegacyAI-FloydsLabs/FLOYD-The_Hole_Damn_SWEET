'use strict';

(function initFloydSetOfMarks(globalScope) {
  const hostScope = globalScope.window && typeof globalScope.window === 'object'
    ? globalScope.window
    : globalScope;

  const _markMap = new Map();
  const _injectedWrappers = [];

  function missingRequiredParameter(name) {
    return { success: false, error: 'Missing required parameter: ' + name };
  }

  function normalizeFilter(value) {
    if (typeof value !== 'string' || value.trim() === '') {
      return 'interactive';
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'all' || normalized === 'forms' || normalized === 'interactive') {
      return normalized;
    }
    return 'interactive';
  }

  function isElementNode(element) {
    const nodeType = hostScope.Node && typeof hostScope.Node.ELEMENT_NODE === 'number'
      ? hostScope.Node.ELEMENT_NODE
      : 1;
    return !!(element && element.nodeType === nodeType);
  }

  function isInteractiveTag(tag) {
    return tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea';
  }

  function isFormTag(tag) {
    return tag === 'form' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button';
  }

  function elementMatchesFilter(element, filter) {
    if (!isElementNode(element) || !element.tagName) return false;
    if (filter === 'all') return true;
    const tag = element.tagName.toLowerCase();
    if (filter === 'forms') return isFormTag(tag);
    return isInteractiveTag(tag);
  }

  function clearMarks() {
    while (_injectedWrappers.length > 0) {
      const wrapper = _injectedWrappers.pop();
      if (!wrapper || !wrapper.parentNode) {
        continue;
      }

      const target = wrapper.__floydMarkTarget;
      wrapper.parentNode.removeChild(wrapper);

      if (target && target.__floydOriginalPosition !== undefined) {
        target.style.position = target.__floydOriginalPosition;
        delete target.__floydOriginalPosition;
      }
    }
    _markMap.clear();
  }

  function getRefsInOrder() {
    const map = hostScope.__floydElementMap;
    if (!(map instanceof Map)) {
      return [];
    }
    const refs = [];
    for (const entry of map.entries()) {
      const ref = entry[0];
      const weak = entry[1];
      if (!weak || typeof weak.deref !== 'function') {
        continue;
      }
      const element = weak.deref();
      if (!isElementNode(element)) {
        map.delete(ref);
        continue;
      }
      refs.push({ ref: ref, element: element });
    }
    return refs;
  }

  function createMarkWrapper(markNumber, refId) {
    const wrapper = document.createElement('span');
    wrapper.setAttribute('data-floyd-injected', 'true');
    wrapper.setAttribute('data-floyd-mark-wrapper', 'true');
    wrapper.style.position = 'absolute';
    wrapper.style.top = '0';
    wrapper.style.right = '0';
    wrapper.style.width = '0';
    wrapper.style.height = '0';
    wrapper.style.overflow = 'visible';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.zIndex = '2147483647';

    const badge = document.createElement('span');
    badge.setAttribute('data-floyd-injected', 'true');
    badge.setAttribute('data-floyd-mark', String(markNumber));
    badge.setAttribute('data-floyd-ref', refId);
    badge.textContent = '[' + markNumber + ']';
    badge.style.position = 'relative';
    badge.style.top = '-6px';
    badge.style.right = '-6px';
    badge.style.display = 'inline-block';
    badge.style.padding = '1px 4px';
    badge.style.borderRadius = '4px';
    badge.style.background = 'rgba(30,30,30,0.85)';
    badge.style.color = '#ffffff';
    badge.style.fontFamily = 'monospace';
    badge.style.fontSize = '11px';
    badge.style.lineHeight = '1.2';
    badge.style.whiteSpace = 'nowrap';
    badge.style.boxSizing = 'border-box';
    badge.style.pointerEvents = 'none';
    badge.style.zIndex = '2147483647';

    wrapper.appendChild(badge);
    return wrapper;
  }

  function setOfMarks(args) {
    const show = !args || typeof args.show === 'undefined' ? true : !!args.show;
    const filter = normalizeFilter(args && args.filter);

    clearMarks();

    if (!show) {
      return { success: true, marks: 0, filter: filter };
    }

    const refs = getRefsInOrder();
    let markCounter = 0;
    for (const item of refs) {
      if (!elementMatchesFilter(item.element, filter)) {
        continue;
      }

      markCounter += 1;
      _markMap.set(markCounter, item.ref);

      const computed = hostScope.getComputedStyle ? hostScope.getComputedStyle(item.element) : null;
      if (computed && computed.position === 'static') {
        item.element.__floydOriginalPosition = item.element.style.position || '';
        item.element.style.position = 'relative';
      } else {
        item.element.__floydOriginalPosition = undefined;
      }

      const wrapper = createMarkWrapper(markCounter, item.ref);
      wrapper.__floydMarkTarget = item.element;
      item.element.appendChild(wrapper);
      _injectedWrappers.push(wrapper);
    }

    return { success: true, marks: markCounter, filter: filter };
  }

  function clickMark(args) {
    if (!args || (typeof args.mark !== 'number' && typeof args.mark !== 'string')) {
      return missingRequiredParameter('mark');
    }

    const markNumber = Number(args.mark);
    if (!Number.isInteger(markNumber) || markNumber <= 0) {
      return { success: false, error: 'Invalid mark: ' + args.mark };
    }

    const refId = _markMap.get(markNumber);
    if (!refId) {
      return { success: false, error: 'Unknown mark: ' + markNumber };
    }

    const map = hostScope.__floydElementMap;
    if (!(map instanceof Map)) {
      return { success: false, error: 'Element reference map is unavailable' };
    }

    const weak = map.get(refId);
    if (!weak || typeof weak.deref !== 'function') {
      return { success: false, error: 'Element ' + refId + ' no longer exists in DOM' };
    }

    const element = weak.deref();
    if (!element) {
      map.delete(refId);
      return { success: false, error: 'Element ' + refId + ' no longer exists in DOM' };
    }

    const view = hostScope.window && typeof hostScope.window === 'object' ? hostScope.window : hostScope;
    let mousedownEvent;
    let clickEvent;
    if (typeof hostScope.MouseEvent === 'function') {
      mousedownEvent = new hostScope.MouseEvent('mousedown', { bubbles: true, cancelable: true, view: view });
      clickEvent = new hostScope.MouseEvent('click', { bubbles: true, cancelable: true, view: view });
    } else {
      mousedownEvent = { type: 'mousedown', bubbles: true, cancelable: true };
      clickEvent = { type: 'click', bubbles: true, cancelable: true };
    }

    element.dispatchEvent(mousedownEvent);
    element.dispatchEvent(clickEvent);

    return {
      success: true,
      mark: markNumber,
      ref: refId,
      tagName: element.tagName ? element.tagName.toLowerCase() : ''
    };
  }

  hostScope.setOfMarks = setOfMarks;
  hostScope.clickMark = clickMark;
  hostScope.__floydSetOfMarks = {
    setOfMarks: setOfMarks,
    clickMark: clickMark,
    _markMap: _markMap
  };

  if (hostScope !== globalScope) {
    globalScope.setOfMarks = setOfMarks;
    globalScope.clickMark = clickMark;
    globalScope.__floydSetOfMarks = hostScope.__floydSetOfMarks;
  }
})(globalThis);

// INTEGRATION: Add to content-script.js: case 'set_of_marks': return setOfMarks(args); case 'click_mark': return clickMark(args);
// INTEGRATION: Add to manifest.json content_scripts with run_at: document_start, all_frames: true
