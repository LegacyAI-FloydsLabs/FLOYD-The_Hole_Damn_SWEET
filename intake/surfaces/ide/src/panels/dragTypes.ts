// CURSE'M IDE — shared drag-and-drop payload types.
//
// Custom dataTransfer MIME types for in-app drags. Kept in a tiny leaf
// module so FileTree, dock tabs, and the canvas can share them without
// pulling each other's dependency graphs together.

/** FileTree row → canvas/dock drop. Payload: workspace-relative path. */
export const FILE_DRAG_MIME = 'application/x-cursem-file';

/** Dock tab → zone/canvas drop. Payload: panel id. */
export const PANEL_DRAG_MIME = 'application/x-cursem-panel';
