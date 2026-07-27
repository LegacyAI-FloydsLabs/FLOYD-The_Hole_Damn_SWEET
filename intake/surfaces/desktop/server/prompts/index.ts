/**
 * Floyd Desktop Web - Prompts Module
 *
 * Central export point for all prompt styles.
 * PHASE 1 ITEM 3: Desktop promptStyle UI Selector
 *
 * Usage:
 * ```ts
 * import { buildSystemPrompt, getAvailablePromptStyles, PROMPT_STYLES } from './prompts/index.js';
 *
 * const prompt = buildSystemPrompt('floyd', { agentName: 'Floyd 4.7' });
 * const styles = getAvailablePromptStyles(); // ['suggested', 'floyd', 'claude']
 * ```
 */

// Re-export all prompt styles
export * from './suggested-prompt.js';
export * from './floyd47-prompt.js';
export * from './claude-prompt.js';

// Re-export the registry
export * from './prompt-registry.js';

// Default export for convenience
export { buildSystemPrompt, getAvailablePromptStyles, PROMPT_STYLES, PROMPT_REGISTRY } from './prompt-registry.js';
