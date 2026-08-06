// CURSE'M IDE — editor stack panel.
//
// The classic editor area (tab bar + toolbar + Monaco host) packaged as a
// panel so it can live in a dock tab or a canvas node. editorStore remains
// the buffer/dirty authority — this wrapper changes nothing about how files
// open, save, or mark dirty; it only re-homes the existing components.

import { TabBar } from '@/components/TabBar';
import { EditorToolbar } from '@/components/EditorToolbar';
import { EditorPane } from '@/editor/EditorPane';

export function EditorStackPanel() {
  return (
    <section className="editor-area" aria-label="Editor">
      <TabBar />
      <EditorToolbar />
      <EditorPane />
    </section>
  );
}
