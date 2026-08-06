// CURSE'M IDE — canvas keyboard shortcuts.
//
// Spatial keyboard nav (feature-map §Workflow 7), dispatched from the
// AppShell window-level keydown handler:
//   Cmd/Ctrl+Arrow → navigateSelect (selection cursor jumps, viewport glides)
//   Shift+Arrow    → panViewport (accumulating pan step)
//
// Focus guard: when a text-consuming surface owns input (terminal, Monaco,
// any input/textarea/contenteditable), Shift+Arrow passes through untouched
// — selection and shell/readline bindings keep working. Cmd+Arrow also
// yields to Monaco/xterm, which bind line-navigation themselves; canvas
// navigation remains available whenever focus is on chrome.

import { getPrimaryCanvasStore } from './canvasRegistry';
import type { NavDirection } from './types';

const ARROW_DIRECTIONS: Record<string, NavDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

function editableHasFocus(event: KeyboardEvent): boolean {
  const target = (event.target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
  return !!target?.closest?.('input, textarea, [contenteditable="true"], .monaco-editor, .xterm');
}

/** Returns true when the event was consumed as a canvas shortcut. */
export function handleCanvasKeydown(event: KeyboardEvent): boolean {
  const direction = ARROW_DIRECTIONS[event.key];
  if (!direction) return false;
  const command = event.metaKey || event.ctrlKey;
  const canvas = getPrimaryCanvasStore().getState();

  if (command && !event.shiftKey && !event.altKey) {
    if (editableHasFocus(event)) return false; // Monaco/xterm line-navigation wins
    event.preventDefault();
    canvas.navigateSelect(direction);
    return true;
  }

  if (!command && event.shiftKey && !event.altKey) {
    if (editableHasFocus(event)) return false; // text selection passes through
    event.preventDefault();
    canvas.panViewport(direction);
    return true;
  }

  return false;
}
