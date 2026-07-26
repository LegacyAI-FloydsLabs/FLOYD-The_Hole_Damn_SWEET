'use strict';

/**
 * Floyd TTY Bridge — Verification Protocol
 * 
 * Provides structured formatting for verification claims between 
 * Tom (Browser Vision) and Floyd (Codebase/Shell).
 */

(function initFloydVerification(globalScope) {
  const hostScope = globalScope.window && typeof globalScope.window === 'object'
    ? globalScope.window
    : globalScope;

  /**
   * Format a verification claim into Markdown
   * 
   * @param {Object} args
   * @param {string} args.claim_id - Unique ID for the claim (e.g. CLAIM-001)
   * @param {string} args.claim_text - The text of the claim being verified
   * @param {string} args.source_doc - Source document or URL
   * @param {string} args.code_reference - File path and line number (e.g. src/auth.ts:42)
   * @param {'verified'|'conflicted'|'unknown'} args.status - Verification status
   * @param {string} [args.notes] - Additional context or evidence
   */
  function formatVerificationReport(args) {
    const { claim_id, claim_text, source_doc, code_reference, status, notes } = args;
    const timestamp = new Date().toISOString();
    
    let statusIcon = '❓';
    if (status === 'verified') statusIcon = '✅';
    if (status === 'conflicted') statusIcon = '❌';

    let md = `### Verification Report: ${claim_id} ${statusIcon}\n\n`;
    md += `- **Status:** ${status.toUpperCase()}\n`;
    md += `- **Claim:** ${claim_text}\n`;
    md += `- **Source:** ${source_doc}\n`;
    md += `- **Code Reference:** \`${code_reference}\`\n`;
    md += `- **Timestamp:** ${timestamp}\n`;
    
    if (notes) {
      md += `\n**Notes:**\n${notes}\n`;
    }
    
    md += '\n---\n';
    return md;
  }

  hostScope.__floydVerification = {
    formatVerificationReport
  };

  if (hostScope !== globalScope) {
    globalScope.__floydVerification = hostScope.__floydVerification;
  }
})(globalThis);
