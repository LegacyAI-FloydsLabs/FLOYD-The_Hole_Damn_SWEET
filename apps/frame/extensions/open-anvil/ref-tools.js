'use strict';

(function initAnvilRefTools(globalScope) {
  const hostScope = globalScope.window && typeof globalScope.window === 'object'
    ? globalScope.window
    : globalScope;

  function missingRequiredParameter(name) {
    return { success: false, error: 'Missing required parameter: ' + name };
  }

  function createMouseEvent(type) {
    if (typeof hostScope.MouseEvent === 'function') {
      return new hostScope.MouseEvent(type, { bubbles: true, cancelable: true, view: hostScope });
    }
    if (typeof globalScope.MouseEvent === 'function') {
      return new globalScope.MouseEvent(type, { bubbles: true, cancelable: true, view: hostScope });
    }
    return { type, bubbles: true, cancelable: true };
  }

  function createSimpleEvent(type) {
    if (typeof hostScope.Event === 'function') {
      return new hostScope.Event(type, { bubbles: true });
    }
    if (typeof globalScope.Event === 'function') {
      return new globalScope.Event(type, { bubbles: true });
    }
    return { type, bubbles: true };
  }

  function getElementFromRef(refId) {
    const map = hostScope.__anvilElementMap;
    if (!(map instanceof Map)) {
      return { error: 'Element reference map is unavailable' };
    }

    const weak = map.get(refId);
    if (!weak || typeof weak.deref !== 'function') {
      return { error: 'Element ' + refId + ' no longer exists in DOM' };
    }

    const element = weak.deref();
    if (!element) {
      map.delete(refId);
      return { error: 'Element ' + refId + ' no longer exists in DOM' };
    }

    return { element };
  }

  function clickRef(args) {
    if (!args || typeof args.ref !== 'string' || args.ref.trim() === '') {
      return missingRequiredParameter('ref');
    }

    const refId = args.ref;
    const resolved = getElementFromRef(refId);
    if (resolved.error) {
      return { success: false, error: resolved.error };
    }

    const element = resolved.element;
    element.dispatchEvent(createMouseEvent('mousedown'));
    element.dispatchEvent(createMouseEvent('click'));

    return { success: true, ref: refId };
  }

  function typeRef(args) {
    if (!args || typeof args.ref !== 'string' || args.ref.trim() === '') {
      return missingRequiredParameter('ref');
    }
    if (!args || typeof args.text !== 'string') {
      return missingRequiredParameter('text');
    }

    const refId = args.ref;
    const resolved = getElementFromRef(refId);
    if (resolved.error) {
      return { success: false, error: resolved.error };
    }

    const element = resolved.element;
    if (typeof element.focus === 'function') {
      element.focus();
    }
    element.value = args.text;
    element.dispatchEvent(createSimpleEvent('input'));
    element.dispatchEvent(createSimpleEvent('change'));

    return { success: true, ref: refId, value: element.value };
  }

  function scrollToRef(args) {
    if (!args || typeof args.ref !== 'string' || args.ref.trim() === '') {
      return missingRequiredParameter('ref');
    }

    const refId = args.ref;
    const resolved = getElementFromRef(refId);
    if (resolved.error) {
      return { success: false, error: resolved.error };
    }

    resolved.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { success: true, ref: refId };
  }

  hostScope.clickRef = clickRef;
  hostScope.typeRef = typeRef;
  hostScope.scrollToRef = scrollToRef;
  hostScope.__anvilRefTools = {
    clickRef,
    typeRef,
    scrollToRef
  };

  if (hostScope !== globalScope) {
    globalScope.clickRef = clickRef;
    globalScope.typeRef = typeRef;
    globalScope.scrollToRef = scrollToRef;
    globalScope.__anvilRefTools = hostScope.__anvilRefTools;
  }
})(globalThis);

// INTEGRATION: Add to content-script.js: case 'click_ref': return clickRef(args); case 'type_ref': return typeRef(args); case 'scroll_to_ref': return scrollToRef(args);
