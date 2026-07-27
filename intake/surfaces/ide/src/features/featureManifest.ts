export const FEATURE_MANIFEST = [
  'Installed-app icon and branded title bar',
  'Emoji-free SVG workbench icon system',
  'CURSEM semantic color system derived from the product mark',
  'System, dark, light, and high-contrast themes',
  'Persistent settings with backed-up editor defaults',
  'Global keyboard shortcut system',
  'Editor undo, redo, find, replace, and formatting commands',
  'One-second autosave and crash-buffer recovery',
  'Workspace quick-open file index',
  'Global file-name and content search',
  'Searchable command palette',
  'Toast notifications for save, import, export, and errors',
  'Resizable and persistent side, terminal, and AI panels',
  'Multi-tab drag reorder, dirty guards, close others, and reopen',
  'Workspace folder selection and file import',
  'Active-file export and clipboard path copy',
  'F1 keyboard reference and welcome dashboard',
  'Accessible focus, semantics, contrast, and reduced motion',
  'Multiple TerminalOne sessions with search and reconnect',
  'Multi-provider coding partner with unified streaming and abort control',
] as const;

export type FeatureName = typeof FEATURE_MANIFEST[number];
