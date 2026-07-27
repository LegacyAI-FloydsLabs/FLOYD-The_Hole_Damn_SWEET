export type EditorCommand =
  | 'save' | 'undo' | 'redo' | 'find' | 'replace' | 'format'
  | 'selectAll' | 'copy' | 'paste' | 'export' | 'inlineEdit';

export function dispatchEditorCommand(command: EditorCommand): void {
  window.dispatchEvent(new CustomEvent<EditorCommand>('cursem:editor-command', { detail: command }));
}
