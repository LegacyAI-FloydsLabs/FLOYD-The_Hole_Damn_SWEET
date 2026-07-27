// CURSE'M IDE — Editor re-exports.

export type {
  EditorAdapter,
  EditorModel,
  Tab,
  EditorSelection,
  FindOptions,
  ReplaceOptions,
  FindResult,
  EditorOptions,
} from './types';
export { detectLanguage } from './types';
export { EditorPane } from './EditorPane';
export { InlineCompletionService, extractCompletion } from './InlineCompletionService';
export type { InlineCompletionRequest, InlineCompletionMetric } from './InlineCompletionService';
export { InlineEditService, extractReplacement, replaceInlineSelection } from './InlineEditService';
export { InlineEditOverlay } from './InlineEditOverlay';
export type { InlineEditRequestDetail } from './types';
