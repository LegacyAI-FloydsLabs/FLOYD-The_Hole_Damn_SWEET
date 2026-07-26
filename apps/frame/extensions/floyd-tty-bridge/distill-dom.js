(function () {
  'use strict';

  const TEXT_ROLES = new Set([
    'heading',
    'paragraph',
    'list',
    'listitem',
    'table',
    'row',
    'cell',
    'blockquote',
    'article',
    'main'
  ]);

  const TEXT_TAGS = new Set([
    'article',
    'main',
    'p',
    'blockquote',
    'ul',
    'ol',
    'li',
    'table',
    'tr',
    'td',
    'th'
  ]);

  const INPUT_ROLES = new Set([
    'form',
    'textbox',
    'combobox',
    'button',
    'checkbox',
    'radio',
    'searchbox',
    'spinbutton',
    'switch'
  ]);

  const INPUT_TAGS = new Set([
    'form',
    'input',
    'select',
    'textarea',
    'button',
    'label'
  ]);

  const STRUCTURAL_NOISE_ROLES = new Set([
    'navigation',
    'contentinfo',
    'complementary',
    'banner'
  ]);

  const STRUCTURAL_NOISE_TAGS = new Set(['nav', 'footer', 'aside']);
  const AD_SOCIAL_PATTERN = /(^|[^a-z])(ad|ads|advert|sponsor|promo|newsletter|cookie|social|share|follow|facebook|twitter|instagram|linkedin|pinterest|youtube|tiktok|widget)([^a-z]|$)/i;

  function parseTreeLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'document') {
      return null;
    }

    const roleMatch = trimmed.match(/^([^\s]+)/);
    const role = roleMatch ? roleMatch[1].toLowerCase() : '';
    const refMatch = trimmed.match(/\[(ref_[^\]]+)\]/);
    const refId = refMatch ? refMatch[1] : '';

    return {
      line,
      role,
      refId
    };
  }

  function resolveElement(refId) {
    if (!refId || typeof window === 'undefined') {
      return null;
    }
    const map = window.__floydElementMap;
    if (!(map instanceof Map)) {
      return null;
    }
    const weak = map.get(refId);
    if (!weak || typeof weak.deref !== 'function') {
      return null;
    }
    return weak.deref() || null;
  }

  function elementTag(element) {
    if (!element || !element.tagName) {
      return '';
    }
    return String(element.tagName).toLowerCase();
  }

  function hasAdOrSocialSignals(element) {
    if (!element) {
      return false;
    }
    const bag = [
      element.id || '',
      element.className || '',
      element.getAttribute ? element.getAttribute('role') || '' : '',
      element.getAttribute ? element.getAttribute('aria-label') || '' : ''
    ].join(' ');

    if (AD_SOCIAL_PATTERN.test(bag)) {
      return true;
    }

    if (typeof element.closest === 'function') {
      const noisyAncestor = element.closest('nav,footer,aside,[role="navigation"],[role="contentinfo"],[role="complementary"],[class*="ad" i],[id*="ad" i],[class*="social" i],[id*="social" i],[class*="share" i],[id*="share" i]');
      return !!noisyAncestor;
    }

    return false;
  }

  function ensureRef(line, index) {
    if (/\[(ref_[^\]]+)\]/.test(line)) {
      return line;
    }
    return line + ' [ref_unavailable_' + index + ']';
  }

  function appendInputMetadata(line, element) {
    if (!element || !element.tagName || typeof line !== 'string') {
      return line;
    }

    const tag = String(element.tagName).toLowerCase();
    const parts = [line];

    const hasType = / type="[^"]*"/.test(line);
    const hasPlaceholder = / placeholder="[^"]*"/.test(line);
    const hasValue = / value="[^"]*"/.test(line);

    const type = tag === 'input'
      ? (element.getAttribute && element.getAttribute('type')) || 'text'
      : tag;
    const placeholder = (element.getAttribute && element.getAttribute('placeholder')) || '';

    let value = '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (typeof element.value === 'string') {
        value = element.value;
      }
    }

    if (!hasType && type) {
      parts.push('type="' + String(type).replace(/"/g, '\\"') + '"');
    }
    if (!hasPlaceholder && placeholder) {
      parts.push('placeholder="' + String(placeholder).replace(/"/g, '\\"') + '"');
    }
    if (!hasValue && value !== '') {
      parts.push('value="' + String(value).replace(/"/g, '\\"') + '"');
    }

    return parts.join(' ');
  }

  function shouldIncludeTextNode(role, tag, element) {
    if (STRUCTURAL_NOISE_ROLES.has(role) || STRUCTURAL_NOISE_TAGS.has(tag)) {
      return false;
    }
    if (hasAdOrSocialSignals(element)) {
      return false;
    }
    if (TEXT_ROLES.has(role)) {
      return true;
    }
    if (tag) {
      if (TEXT_TAGS.has(tag)) {
        return true;
      }
      if (/^h[1-6]$/.test(tag)) {
        return true;
      }
    }
    return false;
  }

  function shouldIncludeInputNode(role, tag, element) {
    if (STRUCTURAL_NOISE_ROLES.has(role) || STRUCTURAL_NOISE_TAGS.has(tag)) {
      return false;
    }
    if (hasAdOrSocialSignals(element)) {
      return false;
    }
    if (INPUT_ROLES.has(role)) {
      return true;
    }
    return INPUT_TAGS.has(tag);
  }

  function countElements(content) {
    if (!content) {
      return 0;
    }
    return content
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line && line !== 'document'; })
      .length;
  }

  function estimateTokens(content) {
    return Math.ceil((content || '').length / 4);
  }

  function distillFromTree(tree, mode) {
    const parsed = tree
      .split('\n')
      .map(parseTreeLine)
      .filter(function (entry) { return !!entry; });

    const filtered = [];
    for (let i = 0; i < parsed.length; i += 1) {
      const entry = parsed[i];
      const element = resolveElement(entry.refId);
      const tag = elementTag(element);

      let include = false;
      if (mode === 'text_only') {
        include = shouldIncludeTextNode(entry.role, tag, element);
      } else if (mode === 'input_fields') {
        include = shouldIncludeInputNode(entry.role, tag, element);
      }

      if (!include) {
        continue;
      }

      let line = ensureRef(entry.line, i + 1);
      if (mode === 'input_fields') {
        line = appendInputMetadata(line, element);
      }
      filtered.push(line);
    }

    return filtered.join('\n');
  }

  function distillDom(args) {
    const params = args || {};
    const mode = typeof params.mode === 'string' ? params.mode : 'all_content';
    const validModes = new Set(['text_only', 'input_fields', 'all_content']);

    if (!validModes.has(mode)) {
      return {
        success: false,
        error: 'Invalid mode: ' + mode + '. Expected one of: text_only, input_fields, all_content.'
      };
    }

    const generator = typeof window !== 'undefined' ? window.__generateAccessibilityTree : null;
    if (typeof generator !== 'function') {
      return {
        success: false,
        error: 'Accessibility tree generator is unavailable. Ensure accessibility-tree.js is loaded.'
      };
    }

    const treeResult = generator(params.filter, params.depth, params.max_chars, params.ref_id);
    if (!treeResult || treeResult.error || typeof treeResult.tree !== 'string') {
      return {
        success: false,
        mode,
        error: treeResult && treeResult.error ? treeResult.error : 'Failed to generate accessibility tree.'
      };
    }

    const content = mode === 'all_content'
      ? treeResult.tree
      : distillFromTree(treeResult.tree, mode);

    return {
      success: true,
      mode,
      content,
      elementCount: countElements(content),
      estimatedTokens: estimateTokens(content)
    };
  }

  if (typeof window !== 'undefined') {
    window.distillDom = distillDom;
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.distillDom = distillDom;
  }
})();

// INTEGRATION: Add to content-script.js: case 'distill_dom': return distillDom(args);
