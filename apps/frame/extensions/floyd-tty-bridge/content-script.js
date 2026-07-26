/**
 * Tom the Peep's Vision Engine — Content Script
 * Full DOM analysis, accessibility auditing, CSS extraction, and page interaction.
 * Injected as a content script into any web page at document_idle.
 */
(function () {
  'use strict';

  // =========================================================================
  // Announce presence to the host page
  // =========================================================================
  window.__TOM_EXTENSION_ID__ = chrome.runtime.id;
  window.dispatchEvent(new CustomEvent('tom-extension-ready'));

  // Initialize DOM change observer (from dom-observer.js, loaded as content_script)
  if (typeof initDomObserver === 'function') initDomObserver();

  // =========================================================================
  // Console Capture Ring Buffer
  // =========================================================================
  const _consoleBuffer = [];
  const _CONSOLE_BUFFER_MAX = 200;
  const _origConsoleLog = console.log;
  const _origConsoleWarn = console.warn;
  const _origConsoleError = console.error;
  const _pageDomain = (window.location && window.location.hostname) || '';

  function _isFromExtension() {
    try {
      const stack = (new Error()).stack || '';
      // Skip our wrapper frames: Error, _isFromExtension, _captureConsole, console.X
      const callerLines = stack.split('\n').slice(4);
      return callerLines.length > 0 && callerLines[0].includes('chrome-extension://');
    } catch (e) {
      return false;
    }
  }

  function _captureConsole(level, args) {
    // Domain filtering: skip messages originating from extension code
    if (_isFromExtension()) return;
    // Only capture when running on a real page (skip about:blank, etc.)
    if (!_pageDomain) return;

    const message = Array.from(args).map(a => {
      try { return String(a); } catch (e) { return '[unstringifiable]'; }
    }).join(' ').substring(0, 2000);

    _consoleBuffer.push({
      level,
      timestamp: Date.now(),
      message,
      source: ''
    });

    if (_consoleBuffer.length > _CONSOLE_BUFFER_MAX) {
      _consoleBuffer.shift();
    }
  }

  console.log = function(...args) {
    _captureConsole('log', args);
    return _origConsoleLog.apply(console, args);
  };

  console.warn = function(...args) {
    _captureConsole('warn', args);
    return _origConsoleWarn.apply(console, args);
  };

  console.error = function(...args) {
    _captureConsole('error', args);
    return _origConsoleError.apply(console, args);
  };

  // =========================================================================
  // Helper Functions
  // =========================================================================

  /**
   * Generate a CSS selector for any element.
   * Prefers #id, then tag.class1.class2, then positional parent > tag:nth-child(n).
   */
  function selectorOf(el) {
    if (!el || el === document || el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);

    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList)
      .filter(c => c && !c.match(/^[0-9]/) && c.length < 60)
      .map(c => '.' + CSS.escape(c))
      .join('');

    // If tag+classes is unique on the page, use it
    if (classes) {
      const candidate = tag + classes;
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (_) { /* invalid selector, fall through */ }
    }

    // Positional: parent > tag:nth-child(n)
    const parent = el.parentElement;
    if (!parent) return tag;
    const children = Array.from(parent.children);
    const idx = children.indexOf(el) + 1;
    const parentSel = selectorOf(parent);
    return parentSel + ' > ' + tag + ':nth-child(' + idx + ')';
  }

  /** Return {x, y, w, h} from getBoundingClientRect, rounded. */
  function getRect(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }

  /** Check display, visibility, opacity, and dimensions. */
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  /** Extract [r, g, b, a] from rgb/rgba string. */
  function parseColor(str) {
    if (!str || str === 'transparent') return [0, 0, 0, 0];
    const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
    if (!m) return null;
    return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), m[4] !== undefined ? parseFloat(m[4]) : 1];
  }

  /** Relative luminance per WCAG 2.0. */
  function luminance(r, g, b) {
    const [rs, gs, bs] = [r, g, b].map(c => {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  /** WCAG luminance-based contrast ratio. */
  function getContrastRatio(fg, bg) {
    const l1 = luminance(fg[0], fg[1], fg[2]);
    const l2 = luminance(bg[0], bg[1], bg[2]);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Walk up DOM to find effective background color (composite alpha over parents).
   * Default to white if we reach the root.
   */
  function getEffectiveBgColor(el) {
    let current = el;
    const layers = [];
    while (current && current !== document) {
      const bg = window.getComputedStyle(current).backgroundColor;
      const parsed = parseColor(bg);
      if (parsed && parsed[3] > 0) {
        layers.push(parsed);
        if (parsed[3] >= 1) break; // Opaque — stop
      }
      current = current.parentElement;
    }
    // Composite from back (bottom of stack) to front, starting from white
    let base = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      base = [
        Math.round(base[0] * (1 - a) + r * a),
        Math.round(base[1] * (1 - a) + g * a),
        Math.round(base[2] * (1 - a) + b * a),
      ];
    }
    return base;
  }

  /** Get direct text content of an element (not deep children). */
  function directText(el) {
    let text = '';
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) text += n.textContent;
    }
    return text.trim();
  }

  /** Get all text content, trimmed and capped. */
  function textOf(el, max) {
    const t = (el.textContent || '').trim();
    return max ? t.substring(0, max) : t;
  }

  /** Center point of an element. */
  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }

  /** Take a lightweight DOM snapshot for diffing. */
  function domSnapshot() {
    return {
      url: location.href,
      title: document.title,
      bodyLength: document.body ? document.body.innerHTML.length : 0,
      elementCount: document.querySelectorAll('*').length,
    };
  }

  /** Diff two DOM snapshots. */
  function diffSnapshots(before, after) {
    const changes = [];
    if (before.url !== after.url) changes.push({ type: 'url_changed', from: before.url, to: after.url });
    if (before.title !== after.title) changes.push({ type: 'title_changed', from: before.title, to: after.title });
    const dLen = after.bodyLength - before.bodyLength;
    if (Math.abs(dLen) > 50) changes.push({ type: 'dom_size_changed', delta: dLen });
    const dEl = after.elementCount - before.elementCount;
    if (dEl !== 0) changes.push({ type: 'element_count_changed', delta: dEl });
    return changes;
  }

  /** Delegate an action to the background service worker. */
  function delegateToBackground(action, data) {
    return new Promise((resolve, reject) => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          throw new Error('Extension context invalidated.');
        }
        chrome.runtime.sendMessage({ action, ...data }, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /** Safely query a selector — returns null on invalid selectors. */
  function safeQuery(selector) {
    try { return document.querySelector(selector); } catch (_) { return null; }
  }
  function safeQueryAll(selector) {
    try { return Array.from(document.querySelectorAll(selector)); } catch (_) { return []; }
  }

  function missingRequiredParameter(name) {
    return { error: 'Missing required parameter: ' + name };
  }

  function getNonEmptyStringArg(args, name) {
    if (!args || typeof args[name] !== 'string' || args[name].trim() === '') {
      return { error: missingRequiredParameter(name) };
    }
    return { value: args[name] };
  }

  function hasNumericArg(args, name) {
    if (!args || typeof args[name] !== 'number' || Number.isNaN(args[name])) {
      return { error: missingRequiredParameter(name) };
    }
    return { value: args[name] };
  }

  function hasArrayArg(args, name) {
    if (!args || !Array.isArray(args[name])) {
      return { error: missingRequiredParameter(name) };
    }
    return { value: args[name] };
  }

  function isValidNavigationUrl(url) {
    return typeof url === 'string' && /^(https?:\/\/|chrome:\/\/)/.test(url);
  }

  /** Get label text for a form input. */
  function getLabelFor(input) {
    if (input.id) {
      const label = document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
      if (label) return label.textContent.trim();
    }
    const parentLabel = input.closest('label');
    if (parentLabel) return parentLabel.textContent.trim();
    if (input.getAttribute('aria-label')) return input.getAttribute('aria-label');
    if (input.getAttribute('aria-labelledby')) {
      const ref = document.getElementById(input.getAttribute('aria-labelledby'));
      if (ref) return ref.textContent.trim();
    }
    return '';
  }

  // =========================================================================
  // Tool Implementations
  // =========================================================================

  // ---- 1. analyze_page ----
  async function analyzePage(args) {
    const url = location.href;
    const title = document.title;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const documentHeight = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );

    // Landmarks
    const landmarkMap = {
      header: 'header, [role="banner"]',
      nav: 'nav, [role="navigation"]',
      main: 'main, [role="main"]',
      aside: 'aside, [role="complementary"]',
      footer: 'footer, [role="contentinfo"]',
      form: 'form',
    };
    const landmarks = {};
    for (const [name, sel] of Object.entries(landmarkMap)) {
      const els = safeQueryAll(sel);
      if (els.length > 0) {
        landmarks[name] = els.map(e => selectorOf(e));
      }
    }

    // Headings
    const headings = safeQueryAll('h1, h2, h3, h4, h5, h6').map(el => ({
      level: parseInt(el.tagName[1]),
      text: textOf(el, 120),
      selector: selectorOf(el),
    }));

    // Images
    const imgEls = safeQueryAll('img');
    const images = imgEls.map(el => {
      const obj = { src: el.src, alt: el.alt, selector: selectorOf(el) };
      if (!el.alt && !el.getAttribute('aria-label') && !el.getAttribute('role')) {
        obj.issue = 'MISSING_ALT';
      }
      return obj;
    });

    // Links (limit 30)
    const linkEls = safeQueryAll('a[href]');
    const links = [];
    for (let i = 0; i < linkEls.length && links.length < 30; i++) {
      const el = linkEls[i];
      links.push({
        text: textOf(el, 100),
        href: el.href,
        selector: selectorOf(el),
        visible: isVisible(el),
      });
    }

    // Forms
    const formEls = safeQueryAll('form');
    const forms = formEls.map(form => {
      const inputs = safeQueryAll('input, select, textarea').filter(inp => form.contains(inp)).map(inp => {
        const label = getLabelFor(inp);
        const obj = {
          type: inp.type || inp.tagName.toLowerCase(),
          name: inp.name,
          label: label,
        };
        if (!label && inp.type !== 'hidden' && inp.type !== 'submit' && inp.type !== 'button') {
          obj.issue = 'MISSING_LABEL';
        }
        return obj;
      });
      return {
        selector: selectorOf(form),
        action: form.action || '',
        inputs,
      };
    });

    // Interactive elements (limit 40)
    const interactiveSel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [tabindex]';
    const interactiveEls = safeQueryAll(interactiveSel);
    const interactiveElements = [];
    for (let i = 0; i < interactiveEls.length && interactiveElements.length < 40; i++) {
      const el = interactiveEls[i];
      if (!isVisible(el)) continue;
      const center = centerOf(el);
      interactiveElements.push({
        tag: el.tagName.toLowerCase(),
        text: textOf(el, 80),
        selector: selectorOf(el),
        aria_label: el.getAttribute('aria-label') || '',
        center,
      });
    }

    // CSS Snapshot
    const allEls = safeQueryAll('*');
    let flexCount = 0, gridCount = 0;
    for (const el of allEls) {
      const d = window.getComputedStyle(el).display;
      if (d === 'flex' || d === 'inline-flex') flexCount++;
      if (d === 'grid' || d === 'inline-grid') gridCount++;
    }

    const customProperties = [];
    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            const text = rule.cssText || '';
            const matches = text.match(/--[\w-]+/g);
            if (matches) {
              for (const m of matches) {
                if (!customProperties.includes(m)) customProperties.push(m);
              }
            }
          }
        } catch (_) { /* cross-origin */ }
      }
    } catch (_) {}

    const animations = [];
    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.type === CSSRule.KEYFRAMES_RULE) {
              animations.push(rule.name);
            }
          }
        } catch (_) {}
      }
    } catch (_) {}

    const mediaQueries = [];
    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.type === CSSRule.MEDIA_RULE && rule.conditionText) {
              if (!mediaQueries.includes(rule.conditionText)) mediaQueries.push(rule.conditionText);
            }
          }
        } catch (_) {}
      }
    } catch (_) {}

    const cssSnapshot = {
      flex_containers: flexCount,
      grid_containers: gridCount,
      custom_properties: customProperties.slice(0, 50),
      animations: animations.slice(0, 20),
      media_queries: mediaQueries.slice(0, 20),
    };

    // Accessibility snapshot
    const missingAlt = images.filter(i => i.issue === 'MISSING_ALT').length;
    const missingLabels = forms.reduce((c, f) => c + f.inputs.filter(i => i.issue === 'MISSING_LABEL').length, 0);
    const accessibilitySnapshot = { missing_alt: missingAlt, missing_labels: missingLabels };

    // Contrast issues
    const contrastIssues = computeContrastIssues();

    // Technical issues
    const technicalIssues = [];
    if (!document.doctype) technicalIssues.push('missing_doctype');
    if (!document.documentElement.lang) technicalIssues.push('missing_lang');
    if (!document.querySelector('meta[name="viewport"]')) technicalIssues.push('missing_viewport_meta');
    if (!document.querySelector('meta[name="description"]')) technicalIssues.push('missing_description');
    const h1Count = safeQueryAll('h1').length;
    if (h1Count === 0) technicalIssues.push('missing_h1');
    if (h1Count > 1) technicalIssues.push('multiple_h1');

    // Score
    let score = 100;
    score -= missingAlt * 5;
    score -= missingLabels * 5;
    score -= contrastIssues.length * 5;
    score -= technicalIssues.length * 3;
    // Count a11y violations from a quick check
    const a11yViolations = (missingAlt > 0 ? 1 : 0) + (missingLabels > 0 ? 1 : 0)
      + (!document.documentElement.lang ? 1 : 0);
    score -= a11yViolations * 4;
    score = Math.max(0, score);

    return {
      url,
      title,
      viewport,
      document_height: documentHeight,
      landmarks,
      headings,
      images: images.slice(0, 50),
      links,
      forms,
      interactive_elements: interactiveElements,
      css_snapshot: cssSnapshot,
      accessibility_snapshot: accessibilitySnapshot,
      contrast_issues: contrastIssues.slice(0, 10),
      technical_issues: technicalIssues,
      score,
    };
  }

  /** Shared contrast issue checker used by analyze_page and check_contrast. */
  function computeContrastIssues(scopeSelector) {
    const scope = scopeSelector ? safeQuery(scopeSelector) : document.body;
    if (!scope) return [];
    const textEls = Array.from(scope.querySelectorAll('p, span, a, button, h1, h2, h3, h4, h5, h6, li, td, th, label'));
    const issues = [];
    for (const el of textEls) {
      if (!isVisible(el)) continue;
      const text = textOf(el, 40);
      if (!text) continue;
      const style = window.getComputedStyle(el);
      const fg = parseColor(style.color);
      if (!fg) continue;
      const bg = getEffectiveBgColor(el);
      const ratio = getContrastRatio(fg, bg);
      const fontSize = parseFloat(style.fontSize);
      const fontWeight = parseInt(style.fontWeight) || 400;
      const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      const required = isLargeText ? 3 : 4.5;
      if (ratio < required) {
        issues.push({
          element: selectorOf(el),
          text: text,
          foreground: 'rgb(' + fg[0] + ',' + fg[1] + ',' + fg[2] + ')',
          background: 'rgb(' + bg[0] + ',' + bg[1] + ',' + bg[2] + ')',
          ratio: Math.round(ratio * 100) / 100,
          required,
          is_large_text: isLargeText,
          fix: 'Increase contrast ratio to at least ' + required + ':1',
        });
      }
      if (issues.length >= 15) break;
    }
    return issues;
  }

  // ---- 2. analyze_element ----
  async function analyzeElement(args) {
    const selectorArg = getNonEmptyStringArg(args, 'selector');
    if (selectorArg.error) return selectorArg.error;
    const selector = selectorArg.value;
    const el = safeQuery(selector);
    if (!el) return { error: 'Element not found: ' + selector };

    const style = window.getComputedStyle(el);
    const rect = getRect(el);

    const attrs = {};
    for (const attr of el.attributes) {
      attrs[attr.name] = attr.value;
    }

    const computedStyles = {};
    const propsToGet = [
      'display', 'position', 'width', 'height', 'margin', 'padding',
      'color', 'backgroundColor', 'fontSize', 'fontFamily', 'fontWeight',
      'lineHeight', 'textAlign', 'border', 'borderRadius', 'overflow',
      'zIndex', 'opacity', 'transform', 'transition', 'animation',
    ];
    for (const p of propsToGet) {
      const v = style[p];
      if (v) computedStyles[p] = v;
    }
    if (style.display === 'flex' || style.display === 'inline-flex') {
      computedStyles.flexDirection = style.flexDirection;
    }
    if (style.display === 'grid' || style.display === 'inline-grid') {
      computedStyles.gridTemplateColumns = style.gridTemplateColumns;
    }

    const accessibility = {
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      'aria-label': el.getAttribute('aria-label') || '',
      'aria-labelledby': el.getAttribute('aria-labelledby') || '',
      'aria-describedby': el.getAttribute('aria-describedby') || '',
      'aria-hidden': el.getAttribute('aria-hidden') || '',
      tabindex: el.getAttribute('tabindex') || '',
    };

    return {
      selector,
      resolved_selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: Array.from(el.classList),
      text: textOf(el, 200),
      inner_html_length: el.innerHTML.length,
      visible: isVisible(el),
      position: rect,
      children_count: el.children.length,
      attributes: attrs,
      computed_styles: computedStyles,
      accessibility,
    };
  }

  // ---- 3. find_elements ----
  async function findElements(args) {
    const queryArg = getNonEmptyStringArg(args, 'query');
    if (queryArg.error) return queryArg.error;
    const query = queryArg.value.toLowerCase();
    const searchBy = args.search_by || 'any';
    const limit = Math.min(typeof args.limit === 'number' && args.limit > 0 ? args.limit : 10, 100);

    const allEls = safeQueryAll('*');
    const results = [];

    for (const el of allEls) {
      if (results.length >= limit) break;
      if (!isVisible(el)) continue;

      let matchType = null;

      if (searchBy === 'any' || searchBy === 'text') {
        const dt = directText(el).toLowerCase();
        if (dt && dt.includes(query)) matchType = 'text';
      }
      if (!matchType && (searchBy === 'any' || searchBy === 'aria')) {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (aria.includes(query)) matchType = 'aria-label';
      }
      if (!matchType && (searchBy === 'any' || searchBy === 'placeholder')) {
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        if (ph.includes(query)) matchType = 'placeholder';
      }
      if (!matchType && (searchBy === 'any' || searchBy === 'alt')) {
        const alt = (el.getAttribute('alt') || '').toLowerCase();
        if (alt.includes(query)) matchType = 'alt';
      }
      if (!matchType && (searchBy === 'any' || searchBy === 'role')) {
        const role = (el.getAttribute('role') || '').toLowerCase();
        if (role.includes(query)) matchType = 'role';
      }
      if (!matchType && searchBy === 'any') {
        const titleAttr = (el.getAttribute('title') || '').toLowerCase();
        if (titleAttr.includes(query)) matchType = 'title';
      }

      if (matchType) {
        const rect = getRect(el);
        results.push({
          match_type: matchType,
          tag: el.tagName.toLowerCase(),
          selector: selectorOf(el),
          text: textOf(el, 100),
          aria_label: el.getAttribute('aria-label') || '',
          center: centerOf(el),
          size: { w: rect.w, h: rect.h },
        });
      }
    }

    return {
      query: args.query,
      results_count: results.length,
      results,
    };
  }

  // ---- 4. check_accessibility ----
  async function checkAccessibility(args) {
    const scopeSel = args.scope || 'body';
    const scope = safeQuery(scopeSel) || document.body;
    const violations = [];

    // 1.1.1 — Images without alt
    const imgs = Array.from(scope.querySelectorAll('img'));
    for (const img of imgs) {
      if (!img.alt && !img.getAttribute('aria-label') && img.getAttribute('role') !== 'presentation') {
        violations.push({
          rule: '1.1.1',
          severity: 'error',
          element: selectorOf(img),
          description: 'Image missing alt text',
          fix: 'Add alt attribute describing the image content',
        });
      }
    }

    // 1.3.1 — Form inputs without labels
    const inputs = Array.from(scope.querySelectorAll('input, select, textarea'));
    for (const inp of inputs) {
      if (inp.type === 'hidden' || inp.type === 'submit' || inp.type === 'button') continue;
      const label = getLabelFor(inp);
      if (!label && !inp.getAttribute('title')) {
        violations.push({
          rule: '1.3.1',
          severity: 'error',
          element: selectorOf(inp),
          description: 'Form input missing label',
          fix: 'Add a <label> element, aria-label, or aria-labelledby',
        });
      }
    }

    // 3.1.1 — Missing lang
    if (!document.documentElement.lang) {
      violations.push({
        rule: '3.1.1',
        severity: 'error',
        element: 'html',
        description: 'Missing lang attribute on <html>',
        fix: 'Add lang="en" (or appropriate language) to <html>',
      });
    }

    // 2.4.1 — Skip navigation
    const firstLink = scope.querySelector('a[href]');
    const hasSkipNav = firstLink && firstLink.href && firstLink.href.includes('#') &&
      (firstLink.textContent || '').toLowerCase().includes('skip');
    if (!hasSkipNav) {
      violations.push({
        rule: '2.4.1',
        severity: 'warning',
        element: 'body',
        description: 'No skip navigation link found',
        fix: 'Add a "Skip to main content" link as the first focusable element',
      });
    }

    // 2.4.4 — Empty links and buttons
    const linksAndButtons = Array.from(scope.querySelectorAll('a[href], button'));
    for (const el of linksAndButtons) {
      const t = textOf(el, 100);
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const imgAlt = el.querySelector('img[alt]');
      if (!t && !aria && !title && !imgAlt) {
        violations.push({
          rule: '2.4.4',
          severity: 'error',
          element: selectorOf(el),
          description: 'Empty ' + el.tagName.toLowerCase() + ' — no accessible text',
          fix: 'Add text content, aria-label, or title attribute',
        });
      }
    }

    // 1.3.1 — Heading order skips
    const headingEls = Array.from(scope.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    let prevLevel = 0;
    for (const h of headingEls) {
      const level = parseInt(h.tagName[1]);
      if (prevLevel > 0 && level > prevLevel + 1) {
        violations.push({
          rule: '1.3.1',
          severity: 'warning',
          element: selectorOf(h),
          description: 'Heading level skipped from h' + prevLevel + ' to h' + level,
          fix: 'Use sequential heading levels without skipping',
        });
      }
      prevLevel = level;
    }

    // 1.4.3 — Contrast issues
    const contrastIssues = computeContrastIssues(scopeSel);
    for (const ci of contrastIssues) {
      violations.push({
        rule: '1.4.3',
        severity: 'warning',
        element: ci.element,
        description: 'Insufficient contrast ratio ' + ci.ratio + ':1 (required ' + ci.required + ':1)',
        fix: ci.fix,
      });
    }

    return {
      scope: scopeSel,
      violations_count: violations.length,
      violations,
    };
  }

  // ---- 5. extract_css ----
  async function extractCss(args) {
    const selectorArg = getNonEmptyStringArg(args, 'selector');
    if (selectorArg.error) return selectorArg.error;
    const selector = selectorArg.value;
    const el = safeQuery(selector);
    if (!el) return { error: 'Element not found: ' + selector };

    const defaultProps = [
      'display', 'position', 'top', 'right', 'bottom', 'left',
      'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
      'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
      'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'color', 'backgroundColor', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle',
      'lineHeight', 'textAlign', 'textDecoration', 'textTransform', 'letterSpacing',
      'border', 'borderRadius', 'boxShadow', 'outline',
      'overflow', 'overflowX', 'overflowY',
      'zIndex', 'opacity', 'cursor', 'pointerEvents',
      'transform', 'transition', 'animation',
      'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'gap',
      'gridTemplateColumns', 'gridTemplateRows', 'gridGap',
    ];

    const properties = args.properties || defaultProps;
    const style = window.getComputedStyle(el);
    const styles = {};
    const trivialValues = new Set(['none', 'normal', 'auto', '0px', 'transparent', 'start', 'stretch', '0s', 'ease']);

    for (const p of properties) {
      const v = style[p];
      if (v && !trivialValues.has(v) && v !== '' && v !== '0') {
        styles[p] = v;
      }
    }

    return { selector, styles };
  }

  // ---- 6. check_contrast ----
  async function checkContrast(args) {
    const issues = computeContrastIssues(args.selector);
    return { issues_count: issues.length, issues };
  }

  // ---- 7. extract_text ----
  async function extractText(args) {
    const selectorArg = getNonEmptyStringArg(args, 'selector');
    if (selectorArg.error) return selectorArg.error;
    const selector = selectorArg.value;
    const els = safeQueryAll(selector);
    if (els.length === 0) return { error: 'No elements found: ' + selector };

    const limit = Math.min(typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50, 100);

    const results = els.slice(0, limit).map(el => ({
      selector: selectorOf(el),
      text: textOf(el, 500),
      visible: isVisible(el),
    }));

    return { count: results.length, results };
  }

  // ---- 8. get_page_state ----
  async function getPageState() {
    const activeEl = document.activeElement;
    return {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
      document_size: {
        width: Math.max(document.body ? document.body.scrollWidth : 0, document.documentElement.scrollWidth),
        height: Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight),
      },
      active_element: activeEl ? selectorOf(activeEl) : null,
      ready_state: document.readyState,
    };
  }

  // ---- 9. click_element ----
  async function clickElement(args) {
    const selectorArg = getNonEmptyStringArg(args, 'selector');
    if (selectorArg.error) return selectorArg.error;
    const selector = selectorArg.value;
    const el = safeQuery(selector);
    if (!el) return { error: 'Element not found: ' + selector };

    const before = domSnapshot();
    el.click();

    await new Promise(resolve => setTimeout(resolve, 500));

    const after = domSnapshot();
    const changes = diffSnapshots(before, after);

    return {
      clicked: selectorOf(el),
      url_after: location.href,
      title_after: document.title,
      changes,
    };
  }

  // ---- 10. scroll_to ----
  async function scrollTo(args) {
    const targetArg = getNonEmptyStringArg(args, 'target');
    if (targetArg.error) return targetArg.error;
    const target = targetArg.value;
    let desc = '';

    if (target === 'top') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      desc = 'top';
    } else if (target === 'bottom') {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      desc = 'bottom';
    } else if (target === 'up') {
      window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' });
      desc = 'up (80vh)';
    } else if (target === 'down') {
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
      desc = 'down (80vh)';
    } else {
      const el = safeQuery(target);
      if (!el) return { error: 'Element not found: ' + target };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      desc = 'element: ' + target;
    }

    await new Promise(resolve => setTimeout(resolve, 400));

    return {
      scrolled_to: desc,
      position: { x: window.scrollX, y: window.scrollY },
    };
  }

  // ---- 11. navigate_to ----
  async function navigateTo(args) {
    const urlArg = getNonEmptyStringArg(args, 'url');
    if (urlArg.error) return urlArg.error;
    const url = urlArg.value;
    if (!isValidNavigationUrl(url)) return { error: 'Invalid URL format: ' + url };
    window.location.href = url;
    return { navigating_to: url };
  }

  // ---- 12. open_tab ----
  async function openTab(args) {
    const urlArg = getNonEmptyStringArg(args, 'url');
    if (urlArg.error) return urlArg.error;
    const url = urlArg.value;
    if (!isValidNavigationUrl(url)) return { error: 'Invalid URL format: ' + url };
    return delegateToBackground('open_tab', { url: url });
  }

  // ---- 13. close_tab ----
  async function closeTab(args) {
    const tabIdArg = hasNumericArg(args, 'tab_id');
    if (tabIdArg.error) return tabIdArg.error;
    return delegateToBackground('close_tab', { tab_id: tabIdArg.value });
  }

  // ---- 14. switch_tab ----
  async function switchTab(args) {
    const tabIdArg = hasNumericArg(args, 'tab_id');
    if (tabIdArg.error) return tabIdArg.error;
    return delegateToBackground('switch_tab', { tab_id: tabIdArg.value });
  }

  // ---- 15. list_tabs ----
  async function listTabs() {
    return delegateToBackground('list_tabs', {});
  }

  // ---- 16. type_text ----
  async function typeText(args) {
    const selectorArg = getNonEmptyStringArg(args, 'selector');
    if (selectorArg.error) return selectorArg.error;
    const selector = selectorArg.value;
    const el = safeQuery(selector);
    if (!el) return { error: 'Element not found: ' + selector };

    el.focus();
    if (args.clear_first) {
      el.value = '';
    }
    el.value = (args.clear_first ? '' : el.value) + (args.text || '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return {
      typed_into: selectorOf(el),
      value: el.value,
    };
  }

  // ---- 17. fill_form ----
  async function fillForm(args) {
    const fieldsArg = hasArrayArg(args, 'fields');
    if (fieldsArg.error) return fieldsArg.error;
    const fields = fieldsArg.value;
    const results = [];

    for (const field of fields) {
      const el = safeQuery(field.selector);
      if (!el) {
        results.push({ selector: field.selector, success: false, error: 'Not found' });
        continue;
      }
      el.focus();
      el.value = field.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      results.push({ selector: field.selector, success: true, value: el.value });
    }

    return { filled: results.length, results };
  }

  // ---- 18. select_option ----
  async function selectOption(args) {
    const selectorArg = getNonEmptyStringArg(args, 'selector');
    if (selectorArg.error) return selectorArg.error;
    const valueArg = getNonEmptyStringArg(args, 'value');
    if (valueArg.error) return valueArg.error;
    const selector = selectorArg.value;
    const value = valueArg.value;
    const el = safeQuery(selector);
    if (!el || el.tagName.toLowerCase() !== 'select') {
      return { error: 'Select element not found: ' + selector };
    }

    let found = false;
    // Try by value first
    for (const opt of el.options) {
      if (opt.value === value) {
        el.value = opt.value;
        found = true;
        break;
      }
    }
    // Then by text
    if (!found) {
      for (const opt of el.options) {
        if (opt.textContent.trim() === value) {
          el.value = opt.value;
          found = true;
          break;
        }
      }
    }

    if (!found) return { error: 'Option not found: ' + value };

    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      selected: selectorOf(el),
      value: el.value,
      text: el.options[el.selectedIndex].textContent.trim(),
    };
  }

  // ---- 19. take_screenshot ----
  async function takeScreenshot() {
    return delegateToBackground('take_screenshot', {});
  }

  // ---- 20. wait_for_element ----
  async function waitForElement(args) {
    const selectorArg = getNonEmptyStringArg(args, 'selector');
    if (selectorArg.error) return selectorArg.error;
    const selector = selectorArg.value;
    const timeout = Math.min(typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 5000, 30000);
    const interval = 100;
    const start = Date.now();

    return new Promise(resolve => {
      const check = () => {
        const el = safeQuery(selector);
        if (el) {
          return resolve({
            success: true,
            selector,
            wait_time: Date.now() - start,
          });
        }
        if (Date.now() - start >= timeout) {
          return resolve({
            success: false,
            error: 'Timeout waiting for element: ' + selector,
            wait_time: timeout,
          });
        }
        setTimeout(check, interval);
      };
      check();
    });
  }

  // ---- 21. get_tab_state ----
  async function getTabState(args) {
    return delegateToBackground('get_tab_state', { tab_id: args.tab_id });
  }

  // ---- 22. write_observation ----
  async function writeObservation(args) {
    let md = '';
    let analysis = null;
    const timestamp = new Date().toISOString();

    if (args.type === 'verification_report') {
      // Use the verification protocol formatter
      if (window.__floydVerification) {
        md = window.__floydVerification.formatVerificationReport(args);
      } else {
        md = `### Verification Report: ${args.claim_id}\n- Status: ${args.status}\n- Claim: ${args.claim_text}\n\n`;
      }
    } else {
      analysis = await analyzePage(args);
      // Format as markdown
      md = '# Page Observation\n\n';
      md += '- **URL:** ' + analysis.url + '\n';
      md += '- **Title:** ' + analysis.title + '\n';
      md += '- **Timestamp:** ' + timestamp + '\n';
      md += '- **Score:** ' + analysis.score + '/100\n';
      md += '- **Viewport:** ' + analysis.viewport.width + 'x' + analysis.viewport.height + '\n\n';

      md += '## Landmarks\n';
      for (const [name, sels] of Object.entries(analysis.landmarks)) {
        md += '- **' + name + ':** ' + sels.join(', ') + '\n';
      }

      md += '\n## Headings (' + analysis.headings.length + ')\n';
      for (const h of analysis.headings) {
        md += '- h' + h.level + ': ' + h.text + '\n';
      }

      md += '\n## Interactive Elements (' + analysis.interactive_elements.length + ')\n';
      for (const ie of analysis.interactive_elements.slice(0, 20)) {
        md += '- [' + ie.tag + '] ' + (ie.text || ie.aria_label || ie.selector).substring(0, 60) + '\n';
      }

      if (analysis.technical_issues.length > 0) {
        md += '\n## Technical Issues\n';
        for (const ti of analysis.technical_issues) {
          md += '- ' + ti + '\n';
        }
      }

      if (analysis.contrast_issues.length > 0) {
        md += '\n## Contrast Issues\n';
        for (const ci of analysis.contrast_issues) {
          md += '- ' + ci.element + ': ratio ' + ci.ratio + ':1 (need ' + ci.required + ':1)\n';
        }
      }
      md += '\n---\n';
    }

    // Store in localStorage
    try {
      const existing = localStorage.getItem('ragbot_observations_md') || '';
      localStorage.setItem('ragbot_observations_md', existing + md);
    } catch (_) { /* localStorage may be unavailable */ }

    // POST to /api/observations if available
    try {
      await fetch('/api/observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: md, analysis, timestamp }),
      });
    } catch (_) { /* API may not exist */ }

    return {
      written: true,
      timestamp,
      score: analysis.score,
    };
  }

  // ---- 23. read_commands ----
  async function readCommands() {
    let commandsMd = '';

    // Try localStorage first
    try {
      commandsMd = localStorage.getItem('ragbot_commands_md') || '';
    } catch (_) {}

    // Try GET /api/commands
    if (!commandsMd) {
      try {
        const res = await fetch('/api/commands');
        if (res.ok) {
          const data = await res.json();
          commandsMd = data.markdown || data.commands || '';
        }
      } catch (_) {}
    }

    // Parse pending commands — each line starting with "- [ ]" or "* [ ]" is pending
    const lines = commandsMd.split('\n');
    const pending = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.match(/^[-*]\s*\[\s*\]/)) {
        pending.push(trimmed.replace(/^[-*]\s*\[\s*\]\s*/, ''));
      }
    }

    return {
      pending_count: pending.length,
      commands: pending,
      raw: commandsMd.substring(0, 2000),
    };
  }

  // ---- 24. query_knowledge ----
  async function queryKnowledge(args) {
    const queryArg = getNonEmptyStringArg(args, 'query');
    if (queryArg.error) return queryArg.error;
    try {
      // Knowledge base endpoint — configurable via chrome.storage.local['knowledge_base_url']
    const stored = await new Promise(r => {
      try { chrome.storage.local.get(['knowledge_base_url'], r); } catch (_) { r({}); }
    });
    const kbUrl = (stored && stored.knowledge_base_url) || 'http://localhost:8080/query';
    const response = await fetch(kbUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: queryArg.value,
          limit: args.limit || 5,
          domain_filter: args.domain || undefined,
          category_filter: args.category || undefined,
        }),
      });
      return await response.json();
    } catch (e) {
      return { error: 'Knowledge base unavailable: ' + e.message };
    }
  }

  async function readPage(args) {
    const generator = window.__generateAccessibilityTree;
    if (typeof generator !== 'function') {
      return { error: 'Accessibility tree generator is unavailable. Ensure accessibility-tree.js is loaded.' };
    }

    const params = args || {};
    return generator(params.filter, params.depth, params.max_chars, params.ref_id);
  }

  // =========================================================================
  // Console Capture Reader
  // =========================================================================
  function readConsole(args) {
    const onlyErrors = args.onlyErrors === true;
    const limit = typeof args.limit === 'number' ? args.limit : 50;
    const clear = args.clear === true;
    const pattern = args.pattern || null;

    let messages = _consoleBuffer.slice();
    const total = messages.length;

    if (onlyErrors) {
      messages = messages.filter(m => m.level === 'error');
    }

    if (pattern) {
      messages = messages.filter(m => m.message.includes(pattern));
    }

    const filtered = messages.length;
    messages = messages.slice(-limit);

    if (clear) {
      _consoleBuffer.length = 0;
    }

    return { success: true, result: { messages, total, filtered } };
  }

  // =========================================================================
  // Tool Router
  // =========================================================================

  async function executeToolCall(name, args) {
    switch (name) {
      case 'analyze_page':       return analyzePage(args);
      case 'analyze_element':    return analyzeElement(args);
      case 'find_elements':      return findElements(args);
      case 'check_accessibility': return checkAccessibility(args);
      case 'extract_css':        return extractCss(args);
      case 'check_contrast':     return checkContrast(args);
      case 'extract_text':       return extractText(args);
      case 'get_page_state':     return getPageState();
      case 'click_element':      return clickElement(args);
      case 'scroll_to':          return scrollTo(args);
      case 'navigate_to':        return navigateTo(args);
      case 'open_tab':           return openTab(args);
      case 'close_tab':          return closeTab(args);
      case 'switch_tab':         return switchTab(args);
      case 'list_tabs':          return listTabs();
      case 'type_text':          return typeText(args);
      case 'fill_form':          return fillForm(args);
      case 'select_option':      return selectOption(args);
      case 'take_screenshot':    return takeScreenshot();
      case 'wait_for_element':   return waitForElement(args);
      case 'get_tab_state':      return getTabState(args);
      case 'write_observation':  return writeObservation(args);
      case 'read_commands':      return readCommands();
      case 'query_knowledge':    return queryKnowledge(args);
      case 'read_page':          return readPage(args);
      case 'read_console':       return readConsole(args);
      case 'click_ref':          return clickRef(args);
      case 'type_ref':           return typeRef(args);
      case 'scroll_to_ref':      return scrollToRef(args);
      case 'distill_dom':        return distillDom(args);
      case 'get_dom_changes':    return getDomChanges(args);
      case 'set_of_marks':       return setOfMarks(args);
      case 'click_mark':         return clickMark(args);
      case 'quick':              return executeQuickCommands(args);
      case 'audit_ui':           return window.__floydUiGate ? window.__floydUiGate.audit() : { error: 'UI Gate not loaded' };
      default:
        return { error: 'Unknown tool: ' + name };
    }
  }

  // =========================================================================
  // Passive Context: DOM Mutation Streaming
  // =========================================================================
  let mutationTimeout = null;
  let lastMutationEmit = Date.now();
  
  const mutationObserver = new MutationObserver((mutations) => {
    if (mutationTimeout) clearTimeout(mutationTimeout);
    
    const now = Date.now();
    const timeSinceLastEmit = now - lastMutationEmit;
    
    // Fire immediately if it's been more than 3 seconds since the last update
    const delay = timeSinceLastEmit > 3000 ? 0 : 1000;
    
    mutationTimeout = setTimeout(() => {
      lastMutationEmit = Date.now();
      const snapshot = domSnapshot();
      try {
        if (chrome.runtime && chrome.runtime.id) {
          chrome.runtime.sendMessage({
            type: 'system_event',
            event: 'dom_mutation',
            details: {
              url: snapshot.url,
              title: snapshot.title,
              elementCount: snapshot.elementCount,
              summary: `DOM settled after mutations.`
            }
          });
        }
      } catch (e) {
        // Extension context might be invalidated on reload
      }
    }, delay);
  });

  if (document.body) {
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'id', 'style']
    });
  }

  // =========================================================================
  // Console & Network Interception (Main World Injection)
  // =========================================================================
  function injectInterceptors() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('interceptors-main.js');
      script.dataset.extId = chrome.runtime.id;
      script.onload = function() {
        this.remove();
      };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.warn('[Tom] Failed to inject interceptors:', e);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'TOM_INTERCEPTOR_EVENT') return;
    const payload = event.data.data;

    // Pipe to terminal via background -> native host
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({
          type: 'interceptor_event',
          payload
        });
      }
    } catch (e) {
      // Extension context invalidated — fail silently
    }
  });

  injectInterceptors();

  // =========================================================================
  // Vision Overlay (The "Look Through Tom's Eyes" Feature)
  // =========================================================================
  function toggleVisionOverlay() {
    const overlayId = 'tom-vision-overlay-container';
    const existing = document.getElementById(overlayId);
    
    if (existing) {
      existing.remove();
      return;
    }

    const container = document.createElement('div');
    container.id = overlayId;
    container.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:2147483647;';
    
    // Target all interactive elements
    const interactiveSel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]';
    const els = safeQueryAll(interactiveSel);
    
    els.forEach(el => {
      if (!isVisible(el)) return;
      
      const rect = el.getBoundingClientRect();
      const box = document.createElement('div');
      
      // Neon green bounding box
      box.style.cssText = `
        position:absolute; 
        border:2px dashed #00ff88; 
        background:rgba(0,255,136,0.1); 
        top:${rect.top + window.scrollY}px; 
        left:${rect.left + window.scrollX}px; 
        width:${rect.width}px; 
        height:${rect.height}px; 
        pointer-events:none;
        box-sizing:border-box;
      `;
      
      // CSS Selector Label
      const label = document.createElement('div');
      label.textContent = selectorOf(el).substring(0, 40);
      label.style.cssText = `
        position:absolute; 
        top:-18px; 
        left:-2px; 
        background:#0a0a0a; 
        color:#00ff88; 
        font-family:monospace; 
        font-size:11px; 
        font-weight:bold;
        padding:2px 6px; 
        white-space:nowrap; 
        border:1px solid #00ff88;
        border-radius:3px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.5);
      `;
      
      box.appendChild(label);
      container.appendChild(box);
    });
    
    document.body.appendChild(container);
  }

  // =========================================================================
  // Message Handler
  // =========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'toggle_vision_overlay') {
      toggleVisionOverlay();
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'tool_call') {
      executeToolCall(message.tool, message.args || {})
        .then(result => {
          sendResponse({
            type: 'tool_response',
            requestId: message.requestId,
            success: true,
            result,
          });
        })
        .catch(err => {
          sendResponse({
            type: 'tool_response',
            requestId: message.requestId,
            success: false,
            error: err.message || String(err),
          });
        });
      return true; // Keep channel open for async response
    }
  });

  console.log('[Tom the Peep] Vision engine loaded. Extension ID:', chrome.runtime.id);
})();
