import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

function lineDirections(view: EditorView): DecorationSet {
  const lines = [];
  for (const range of view.visibleRanges) {
    for (let pos = range.from; pos <= range.to;) {
      const line = view.state.doc.lineAt(pos);
      lines.push(Decoration.line({ attributes: { dir: 'auto' } }).range(line.from));
      pos = line.to + 1;
    }
  }
  return Decoration.set(lines, true);
}

const directionalLines = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = lineDirections(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.decorations = lineDirections(update.view);
  }
}, { decorations: plugin => plugin.decorations });

/** CodeMirror must measure each line's direction for correct cursor movement in mixed text. */
export const editorDirection = [EditorView.perLineTextDirection.of(true), directionalLines];
