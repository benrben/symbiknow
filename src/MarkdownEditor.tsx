import { useEffect, useRef, type KeyboardEvent } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import './editor.css';

export type EditorMode = 'source' | 'split' | 'preview';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: '#fbfcff' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.65' },
  '.cm-content': { padding: '14px 0', caretColor: '#3e55c3' },
  '.cm-gutters': { backgroundColor: '#f3f5fb', color: '#a3adc0', border: 'none', borderRight: '1px solid #e6eaf3' },
  '.cm-activeLine': { backgroundColor: '#eef2ff80' },
  '.cm-activeLineGutter': { backgroundColor: '#e6ebfb', color: '#3e55c3' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#d5defd !important' },
  '.cm-cursor': { borderLeftColor: '#3e55c3', borderLeftWidth: '2px' },
});

function isHtmlDocument(content: string): boolean {
  return /^---\r?\nformat:\s*html\s*\r?\n---/i.test(content);
}

/** CodeMirror source editor. Mod-E switches between source and preview. */
export function MarkdownEditor({ value, onChange, label, onToggleView }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  onToggleView?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onToggleRef = useRef(onToggleView);
  onChangeRef.current = onChange;
  onToggleRef.current = onToggleView;
  const htmlDocument = isHtmlDocument(value);

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions: [
        basicSetup, EditorView.lineWrapping, theme,
        language.current.of(htmlDocument ? html() : markdown()),
        EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'true' }),
        keymap.of([{ key: 'Mod-e', preventDefault: true, run: () => { onToggleRef.current?.(); return true; } }]),
        EditorView.updateListener.of(update => { if (update.docChanged) onChangeRef.current(update.state.doc.toString()); }),
      ] }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
    // The editor owns its document after mount; later value changes are applied by the next effect.
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: language.current.reconfigure(htmlDocument ? html() : markdown()) });
  }, [htmlDocument]);

  return <div className="code-editor" ref={host}/>;
}

const modes: Array<{ id: EditorMode; label: string }> = [
  { id: 'source', label: 'Source' }, { id: 'split', label: 'Split' }, { id: 'preview', label: 'Preview' },
];

/** Segmented switch with a sliding highlight. Arrow keys move between modes. */
export function ViewToggle({ mode, onChange }: { mode: EditorMode; onChange: (mode: EditorMode) => void }) {
  const index = modes.findIndex(item => item.id === mode);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = modes[(index + (event.key === 'ArrowRight' ? 1 : modes.length - 1)) % modes.length];
    onChange(next.id);
  }
  return <div className="view-toggle" role="group" aria-label="Editor view" onKeyDown={onKeyDown} style={{ '--toggle-index': index } as React.CSSProperties}>
    <span className="view-toggle__thumb" aria-hidden="true"/>
    {modes.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => onChange(item.id)}>
      <span className={`view-toggle__icon view-toggle__icon--${item.id}`} aria-hidden="true"/>{item.label}
    </button>)}
  </div>;
}
