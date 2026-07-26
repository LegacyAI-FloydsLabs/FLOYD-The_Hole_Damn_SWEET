// net-rules.js — declarativeNetRequest dynamic rules engine for Open Anvil
'use strict';

(function initNetRules(globalScope) {
  const MAX_DYNAMIC_RULES = 5000;
  const VALID_ACTIONS = ['block', 'redirect', 'modifyHeaders'];
  const VALID_HEADER_OPS = ['append', 'set', 'remove'];

  /**
   * Add or update a declarativeNetRequest dynamic rule (upsert pattern).
   * Removes any existing rule with the same ID before adding the new one.
   *
   * @param {object} args
   * @param {number} args.id - Positive integer rule ID
   * @param {string} args.action - "block" | "redirect" | "modifyHeaders"
   * @param {object} args.condition - { urlFilter: string, resourceTypes?: string[] }
   * @param {object} [args.redirect] - { url: string } (required for "redirect" action)
   * @param {Array}  [args.headers] - [{ header, operation, value }] (required for "modifyHeaders" action)
   * @returns {Promise<{success: boolean, ruleId?: number, error?: string}>}
   */
  async function addNetRule(args) {
    try {
      // ── Validate rule ID ──
      if (!Number.isInteger(args.id) || args.id < 1) {
        return { success: false, error: 'Rule ID must be a positive integer' };
      }

      // ── Validate action ──
      if (!VALID_ACTIONS.includes(args.action)) {
        return { success: false, error: `Invalid action "${args.action}". Must be one of: ${VALID_ACTIONS.join(', ')}` };
      }

      // ── Validate condition ──
      if (!args.condition || typeof args.condition.urlFilter !== 'string' || !args.condition.urlFilter) {
        return { success: false, error: 'condition.urlFilter is required and must be a non-empty string' };
      }

      // ── Validate redirect ──
      if (args.action === 'redirect') {
        if (!args.redirect || typeof args.redirect.url !== 'string' || !args.redirect.url) {
          return { success: false, error: 'redirect.url is required for redirect action' };
        }
      }

      // ── Validate headers ──
      if (args.action === 'modifyHeaders') {
        if (!Array.isArray(args.headers) || args.headers.length === 0) {
          return { success: false, error: 'headers array is required for modifyHeaders action' };
        }
        for (const h of args.headers) {
          if (!h.header || typeof h.header !== 'string') {
            return { success: false, error: 'Each header must have a non-empty "header" string' };
          }
          if (!VALID_HEADER_OPS.includes(h.operation)) {
            return { success: false, error: `Invalid header operation "${h.operation}". Must be one of: ${VALID_HEADER_OPS.join(', ')}` };
          }
        }
      }

      // ── Guard: max dynamic rules ──
      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      // If updating an existing rule, count stays the same; otherwise +1
      const wouldExist = existingRules.some(r => r.id === args.id)
        ? existingRules.length
        : existingRules.length + 1;
      if (wouldExist > MAX_DYNAMIC_RULES) {
        return { success: false, error: `Cannot exceed ${MAX_DYNAMIC_RULES} dynamic rules` };
      }

      // ── Build rule ──
      const rule = {
        id: args.id,
        priority: args.priority || 1,
        action: { type: args.action },
        condition: {
          urlFilter: args.condition.urlFilter
        }
      };

      if (args.condition.resourceTypes) {
        rule.condition.resourceTypes = args.condition.resourceTypes;
      }

      if (args.action === 'redirect') {
        rule.action.redirect = { url: args.redirect.url };
      }

      if (args.action === 'modifyHeaders') {
        rule.action.requestHeaders = args.headers.map(h => ({
          header: h.header,
          operation: h.operation,
          value: h.value
        }));
      }

      // ── Upsert: remove old rule with same ID, then add new ──
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [rule],
        removeRuleIds: [args.id]
      });

      return { success: true, ruleId: args.id };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to add net rule' };
    }
  }

  /**
   * Remove a declarativeNetRequest dynamic rule by ID.
   *
   * @param {object} args
   * @param {number} args.id - Positive integer rule ID to remove
   * @returns {Promise<{success: boolean, removedId?: number, error?: string}>}
   */
  async function removeNetRule(args) {
    try {
      if (!Number.isInteger(args.id) || args.id < 1) {
        return { success: false, error: 'Rule ID must be a positive integer' };
      }

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [args.id]
      });

      return { success: true, removedId: args.id };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to remove net rule' };
    }
  }

  // Expose on globalThis for importScripts() in service worker
  globalScope.addNetRule = addNetRule;
  globalScope.removeNetRule = removeNetRule;
})(globalThis);

// INTEGRATION: importScripts('net-rules.js'); in background.js line 3 area
// INTEGRATION: Add to background.js handleBrowserApiTool(): case 'add_net_rule': return addNetRule(args); case 'remove_net_rule': return removeNetRule(args);
// INTEGRATION: Add "declarativeNetRequestWithHostAccess" to manifest.json permissions array
