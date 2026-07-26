(function () {
  'use strict';

  if (!(window.__anvilElementMap instanceof Map)) {
    window.__anvilElementMap = new Map();
  }
  if (!Number.isInteger(window.__anvilRefCounter) || window.__anvilRefCounter < 0) {
    window.__anvilRefCounter = 0;
  }
  if (!(window.__anvilElementReverseMap instanceof WeakMap)) {
    window.__anvilElementReverseMap = new WeakMap();
  }

  function pruneDeadRefs() {
    for (const entry of window.__anvilElementMap.entries()) {
      const ref = entry[0];
      const weak = entry[1];
      const deref = weak && weak.deref ? weak.deref() : null;
      if (!deref) {
        window.__anvilElementMap.delete(ref);
      }
    }
  }

  if (typeof window.__anvilRefPruneTimer === 'undefined' && typeof setInterval === 'function') {
    window.__anvilRefPruneTimer = setInterval(pruneDeadRefs, 60000);
  }

  const interactiveRoles = new Set([
    'button', 'link', 'textbox', 'checkbox', 'combobox', 'radio', 'switch',
    'tab', 'menuitem', 'option', 'slider', 'spinbutton', 'searchbox', 'dialog'
  ]);

  const simpleRoleMap = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    img: 'img',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    aside: 'complementary',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    table: 'table',
    tr: 'row',
    td: 'cell',
    th: 'cell',
    form: 'form',
    dialog: 'dialog',
    details: 'group',
    summary: 'button'
  };

  function weakRefFor(element) {
    if (typeof WeakRef === 'function') {
      return new WeakRef(element);
    }
    return { deref: function () { return element; } };
  }

  function normalizeText(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim();
  }

  function resolveAriaLabelledBy(element) {
    const attr = element.getAttribute('aria-labelledby');
    if (!attr) return '';
    const ids = attr.split(/\s+/).filter(Boolean);
    const parts = [];
    for (const id of ids) {
      const target = document.getElementById(id);
      if (!target) continue;
      const text = normalizeText(target.textContent || '');
      if (text) parts.push(text);
    }
    return normalizeText(parts.join(' '));
  }

  function getAssociatedLabel(element) {
    if (element.id) {
      const label = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
      const text = normalizeText(label ? label.textContent || '' : '');
      if (text) return text;
    }
    const parentLabel = element.closest('label');
    return normalizeText(parentLabel ? parentLabel.textContent || '' : '');
  }

  function isLeafForNaming(element) {
    for (const child of element.children) {
      if (isIncludedElement(child)) {
        return false;
      }
    }
    return true;
  }

  function getAccessibleName(element) {
    const ariaLabel = normalizeText(element.getAttribute('aria-label') || '');
    if (ariaLabel) return ariaLabel;

    const ariaLabelledBy = resolveAriaLabelledBy(element);
    if (ariaLabelledBy) return ariaLabelledBy;

    const placeholder = normalizeText(element.getAttribute('placeholder') || '');
    if (placeholder) return placeholder;

    const title = normalizeText(element.getAttribute('title') || '');
    if (title) return title;

    const alt = normalizeText(element.getAttribute('alt') || '');
    if (alt) return alt;

    const label = getAssociatedLabel(element);
    if (label) return label;

    if (isLeafForNaming(element)) {
      return normalizeText(element.textContent || '');
    }

    return '';
  }

  function isIncludedElement(node) {
    return !!(node && node.nodeType === Node.ELEMENT_NODE);
  }

  function isHidden(element) {
    if (element.getAttribute('aria-hidden') === 'true') return true;
    const style = window.getComputedStyle ? window.getComputedStyle(element) : null;
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    return false;
  }

  function getRole(element) {
    const explicitRole = normalizeText(element.getAttribute('role') || '');
    if (explicitRole) return explicitRole;

    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';

    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'text' || type === 'search' || type === 'email' || type === 'url' || type === 'tel' || type === 'password') {
        return 'textbox';
      }
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'generic';
    }

    if (simpleRoleMap[tag]) return simpleRoleMap[tag];

    if ((tag === 'div' || tag === 'span')) return 'generic';

    return 'generic';
  }

  function getOrCreateRef(element, shouldAssign) {
    if (!shouldAssign) return '';

    const reverseMap = window.__anvilElementReverseMap;
    const cached = reverseMap.get(element);
    if (cached) {
      const existing = window.__anvilElementMap.get(cached);
      if (existing && existing.deref && existing.deref() === element) {
        return cached;
      }
    }

    for (const entry of window.__anvilElementMap.entries()) {
      const ref = entry[0];
      const weak = entry[1];
      const deref = weak && weak.deref ? weak.deref() : null;
      if (!deref) {
        window.__anvilElementMap.delete(ref);
        continue;
      }
      if (deref === element) {
        reverseMap.set(element, ref);
        return ref;
      }
    }

    window.__anvilRefCounter += 1;
    const newRef = 'ref_' + window.__anvilRefCounter;
    window.__anvilElementMap.set(newRef, weakRefFor(element));
    reverseMap.set(element, newRef);
    return newRef;
  }

  function formatAttribute(name, value) {
    if (value === null || value === undefined || value === '') return '';
    return ' ' + name + '="' + String(value).replace(/"/g, '\\"') + '"';
  }

  function describeElement(element, role, name, ref) {
    const parts = [role];
    if (name) {
      parts.push('"' + name.replace(/"/g, '\\"') + '"');
    }
    if (ref) {
      parts.push('[' + ref + ']');
    }

    const tag = element.tagName.toLowerCase();
    if (tag === 'a') {
      const href = element.getAttribute('href');
      if (href) parts.push('href="' + href.replace(/"/g, '\\"') + '"');
    }
    if (tag === 'input') {
      const type = element.getAttribute('type');
      if (type) parts.push('type="' + type.replace(/"/g, '\\"') + '"');
      const placeholder = element.getAttribute('placeholder');
      if (placeholder) parts.push('placeholder="' + placeholder.replace(/"/g, '\\"') + '"');
      if (typeof element.value === 'string' && element.value !== '') {
        parts.push('value="' + element.value.replace(/"/g, '\\"') + '"');
      }
    }

    const ariaExpanded = element.getAttribute('aria-expanded');
    if (ariaExpanded !== null) parts.push('aria-expanded="' + ariaExpanded.replace(/"/g, '\\"') + '"');

    const ariaChecked = element.getAttribute('aria-checked');
    if (ariaChecked !== null) parts.push('aria-checked="' + ariaChecked.replace(/"/g, '\\"') + '"');

    if (element.hasAttribute('disabled') || element.disabled === true) {
      parts.push('disabled');
    }

    if (role === 'heading') {
      const level = parseInt(tag.slice(1), 10);
      if (!Number.isNaN(level)) {
        parts.push('level=' + level);
      }
    }

    return parts.join(' ');
  }

  function getElementByRefId(refId) {
    if (!refId) return null;
    const weak = window.__anvilElementMap.get(refId);
    if (!weak || !weak.deref) return null;
    const element = weak.deref();
    if (!element) {
      window.__anvilElementMap.delete(refId);
      return null;
    }
    return element;
  }

  window.__generateAccessibilityTree = function (filter, depth, maxChars, refId) {
    try {
      pruneDeadRefs();

      const normalizedFilter = normalizeText(typeof filter === 'string' ? filter : '').toLowerCase();
      const maxDepth = typeof depth === 'number' && depth >= 0 ? depth : Number.POSITIVE_INFINITY;
      const maxOutputChars = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 0;

      let root = document.documentElement;
      if (refId) {
        const scoped = getElementByRefId(refId);
        if (!scoped) {
          return { error: 'Invalid ref_id: ' + refId };
        }
        root = scoped;
      }

      const lines = ['document'];

      function visit(element, domDepth) {
        if (!isIncludedElement(element)) return;
        if (isHidden(element)) return;
        if (domDepth > maxDepth) return;

        const role = getRole(element);
        const name = getAccessibleName(element);
        const shouldSkipGeneric = role === 'generic' && !name;

        const shouldAssignRef = !!name || interactiveRoles.has(role);
        const ref = getOrCreateRef(element, shouldAssignRef);

        const roleMatches = !normalizedFilter || role.toLowerCase() === normalizedFilter;
        if (!shouldSkipGeneric && roleMatches) {
          const indent = '  '.repeat(Math.max(domDepth, 1));
          lines.push(indent + describeElement(element, role, name, ref));
        }

        const children = element.children ? Array.from(element.children) : [];
        for (const child of children) {
          visit(child, domDepth + 1);
        }
      }

      if (root === document.documentElement) {
        for (const child of Array.from(document.documentElement.children || [])) {
          visit(child, 1);
        }
      } else {
        visit(root, 1);
      }

      const output = lines.join('\n');
      if (maxOutputChars > 0 && output.length > maxOutputChars) {
        return {
          error: 'Accessibility tree exceeds max_chars (' + maxOutputChars + '). Try a smaller depth or provide ref_id to scope output.'
        };
      }

      return { tree: output };
    } catch (error) {
      return { error: 'Failed to generate accessibility tree: ' + error.message };
    }
  };
})();
