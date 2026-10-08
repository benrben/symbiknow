// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { EditorView } from 'codemirror';
import { language } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { MarkdownEditor, ViewToggle, type EditorMode } from './MarkdownEditor';
import { installWorkspaceBrowser } from './AppWorkspaceView.test.helpers';

installWorkspaceBrowser();
const markdown = '# Original evidence\nReview the source.';
const html = '---\nformat: html\n---\n<main><h1>HTML evidence</h1></main>';

function installedEditor() {
  const source = screen.getByRole('textbox', { name: 'Native source' });
  const editor = EditorView.findFromDOM(source);
  if (!editor) throw new Error('Missing installed CodeMirror editor');
  return editor;
}
function EditorOwner({ initial = markdown }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  const [phase, setPhase] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [changes, setChanges] = useState<string[]>([]);
  const [toggles, setToggles] = useState<number[]>([]);
  return <>
    <button onClick={() => { setPhase(value => value + 1); }}>Replace owner callbacks</button>
    <button onClick={() => { setEnabled(value => !value); }}>Toggle optional shortcut</button>
    <button onClick={() => { setValue(html); }}>Load HTML source</button>
    <button onClick={() => { setValue(markdown); }}>Load Markdown source</button>
    <output aria-label="Owner changes">{JSON.stringify(changes)}</output>
    <output aria-label="Owner toggles">{JSON.stringify(toggles)}</output>
    <MarkdownEditor value={value} label="Native source" onChange={text => {
      setValue(text); setChanges(values => [...values, phase + ':' + text]);
    }} onToggleView={enabled ? () => { setToggles(values => [...values, phase]); } : undefined} />
  </>;
}
function ToggleOwner() {
  const [mode, setMode] = useState<EditorMode>('source');
  const [keys, setKeys] = useState<{ key: string; prevented: boolean }[]>([]);
  return <div onKeyDown={event => { setKeys(values => [...values, { key: event.key, prevented: event.defaultPrevented }]); }}>
    <output aria-label="Owner key events">{JSON.stringify(keys)}</output>
    <ViewToggle mode={mode} onChange={setMode} />
  </div>;
}

describe('MarkdownEditor with installed CodeMirror and public React lifecycle', () => {
  it('sets automatic direction on every source line and retains it after editing mixed text', async () => {
    render(<EditorOwner initial={'# שלום עולם\n\nمرحبا بالعالم\n\nEnglish text'} />);
    const editor = installedEditor();
    expect(editor.state.facet(EditorView.perLineTextDirection)).toBe(true);
    expect([...editor.contentDOM.querySelectorAll('.cm-line')].every(line => line.getAttribute('dir') === 'auto')).toBe(true);
    await act(async () => { editor.dispatch({ changes: { from: editor.state.doc.length, insert: '\nשורה חדשה' } }); });
    expect(editor.contentDOM.querySelector('.cm-line:last-child')?.getAttribute('dir')).toBe('auto');
    expect(editor.state.doc.toString()).toContain('שורה חדשה');
    await act(async () => { editor.dispatch({ selection: { anchor: 2 } }); });
    expect(editor.contentDOM.querySelector('.cm-line')?.getAttribute('dir')).toBe('auto');
  });

  it('initializes an HTML document under StrictMode and accepts a later Markdown value through the existing editor', () => {
    render(<StrictMode><EditorOwner initial={html} /></StrictMode>);
    const editor = installedEditor();
    expect(editor.state.doc.toString()).toBe(html);
    expect(editor.state.facet(language)?.name).toBe('html');
    expect(document.querySelectorAll('.cm-editor')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load Markdown source' }));
    expect(installedEditor()).toBe(editor);
    expect(editor.state.doc.toString()).toBe(markdown);
    expect(editor.state.facet(language)?.name).toBe('markdown');
  });

  it('handles optional Mod-E without editing text and calls only the latest enabled owner callback', () => {
    render(<EditorOwner />);
    const editor = installedEditor();
    const source = screen.getByRole('textbox', { name: 'Native source' });
    source.focus();
    expect(fireEvent.keyDown(source, { key: 'e', code: 'KeyE', ctrlKey: true })).toBe(false);
    expect(editor.state.doc.toString()).toBe(markdown);
    expect(screen.getByLabelText('Owner toggles').textContent).toBe('[]');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle optional shortcut' }));
    fireEvent.keyDown(source, { key: 'e', code: 'KeyE', ctrlKey: true });
    expect(screen.getByLabelText('Owner toggles').textContent).toBe('[0]');
    fireEvent.click(screen.getByRole('button', { name: 'Replace owner callbacks' }));
    fireEvent.keyDown(source, { key: 'e', code: 'KeyE', ctrlKey: true });
    expect(screen.getByLabelText('Owner toggles').textContent).toBe('[0,1]');
    expect(installedEditor()).toBe(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle optional shortcut' }));
    fireEvent.keyDown(source, { key: 'e', code: 'KeyE', ctrlKey: true });
    expect(screen.getByLabelText('Owner toggles').textContent).toBe('[0,1]');
    expect(screen.getByLabelText('Owner changes').textContent).toBe('[]');
  });

  it('applies public document transactions and controlled value/language changes in one StrictMode editor, then removes native input listeners on unmount', async () => {
    const owner = render(<StrictMode><EditorOwner /></StrictMode>);
    const editor = installedEditor();
    const source = screen.getByRole('textbox', { name: 'Native source' });
    expect(document.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(source.getAttribute('spellcheck')).toBe('true');
    expect(editor.state.facet(language)?.name).toBe('markdown');
    fireEvent.click(screen.getByRole('button', { name: 'Replace owner callbacks' }));
    await act(async () => { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '# Updated native evidence' } }); });
    expect(screen.getByLabelText('Owner changes').textContent).toBe('["1:# Updated native evidence"]');
    fireEvent.click(screen.getByRole('button', { name: 'Load HTML source' }));
    expect(installedEditor()).toBe(editor);
    expect(editor.state.doc.toString()).toBe(html);
    expect(editor.state.facet(language)?.name).toBe('html');
    fireEvent.click(screen.getByRole('button', { name: 'Load Markdown source' }));
    expect(editor.state.doc.toString()).toBe(markdown);
    expect(editor.state.facet(language)?.name).toBe('markdown');
    expect(document.querySelectorAll('.cm-editor')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle optional shortcut' }));
    const output = screen.getByLabelText('Owner toggles');
    const before = output.textContent;
    owner.unmount();
    expect(source.isConnected).toBe(false);
    expect(editor.dom.isConnected).toBe(false);
    fireEvent.keyDown(source, { key: 'e', code: 'KeyE', ctrlKey: true });
    fireEvent.input(source, { inputType: 'insertText', data: 'Detached native input' });
    expect(output.textContent).toBe(before);
    expect(document.querySelector('.cm-editor')).toBeNull();
  });
});

describe('ViewToggle native keyboard and button contract', () => {
  it('cycles both arrow directions with wrapping, prevents arrow defaults and preserves normal-key propagation and button activation', async () => {
    render(<ToggleOwner />);
    const group = screen.getByRole('group', { name: 'Editor view' });
    const button = (name: string) => within(group).getByRole('button', { name });
    button('Source').focus();
    for (const name of ['Split', 'Preview', 'Source']) {
      await userEvent.keyboard('{ArrowRight}');
      expect(button(name).getAttribute('aria-pressed')).toBe('true');
    }
    for (const name of ['Preview', 'Split', 'Source']) {
      await userEvent.keyboard('{ArrowLeft}');
      expect(button(name).getAttribute('aria-pressed')).toBe('true');
    }
    const arrowEvents = JSON.parse(screen.getByLabelText('Owner key events').textContent ?? '[]') as { key: string; prevented: boolean }[];
    expect(arrowEvents).toEqual([
      ...Array.from({ length: 3 }, () => ({ key: 'ArrowRight', prevented: true })),
      ...Array.from({ length: 3 }, () => ({ key: 'ArrowLeft', prevented: true })),
    ]);
    await userEvent.keyboard('x');
    expect(button('Source').getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(screen.getByLabelText('Owner key events').textContent ?? '[]').at(-1)).toEqual({ key: 'x', prevented: false });
    for (const name of ['Split', 'Preview', 'Source']) {
      await userEvent.click(button(name));
      expect(button(name).getAttribute('aria-pressed')).toBe('true');
    }
  });
});
