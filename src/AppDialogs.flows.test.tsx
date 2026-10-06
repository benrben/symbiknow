// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { FullPageReader, ModalOverlay } from './AppDialogs';
import { browserActor } from './api';
import type { AppDialogModel } from './app-dialog-contract';
import type { BlockDraft } from './app-model-helpers';
import type { CanvasBlock } from '../shared/types';

vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange, onToggleView }: { value: string; onChange: (value: string) => void; onToggleView: () => void }) =>
    <textarea aria-label="Markdown source" value={value} onChange={event => onChange(event.currentTarget.value)} onKeyDown={event => { if (event.metaKey && event.key === 'e') onToggleView(); }}/>,
  ViewToggle: ({ mode, onChange }: { mode: string; onChange: (value: string) => void }) => <div className="view-toggle">{['source', 'split', 'preview'].map(value => <button type="button" key={value} aria-pressed={mode === value} onClick={() => onChange(value)}>{value}</button>)}</div>,
}));
vi.mock('./Loaders', () => ({ BlockContent: ({ block, onUpdateBlock, onError }: {
  block: CanvasBlock; onUpdateBlock: (id: string, patch: Partial<CanvasBlock>) => Promise<void>; onError: (message: string) => void;
}) => <div><span>{block.title}: {block.content}</span>
  <button type="button" onClick={() => void onUpdateBlock(block.id, { content: 'Preview changed' })}>Change preview</button>
  <button type="button" onClick={() => void onUpdateBlock(block.id, {})}>Keep preview</button>
  <button type="button" onClick={() => void onUpdateBlock(block.id, { content: null } as unknown as Partial<CanvasBlock>)}>Clear optional patch</button>
  <button type="button" onClick={() => onError('Preview unavailable')}>Preview error</button></div> }));
vi.mock('./SettingsPage', () => ({ SettingsPage: ({ onCancel, onOpenHistory }: { onCancel: () => void; onOpenHistory: (...args: string[]) => void }) =>
  <div><button onClick={onCancel}>Cancel settings</button><button onClick={() => onOpenHistory('canvas', 'one', 'revision')}>Settings history</button></div> }));
vi.mock('./VersionPanel', () => ({ VersionPanel: ({ block, initialRevision, onChanged }: { block: CanvasBlock; initialRevision?: string; onChanged: () => Promise<void> }) =>
  <div>History for {block.title} at {initialRevision}<button onClick={() => void onChanged()}>Refresh saved version</button></div> }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const first: CanvasBlock = { id: 'one', title: 'First', kind: 'markdown', content: 'First passage', contentHash: 'h1', file: 'one.md', x: 0, y: 0, width: 400, height: 320, links: [] };
const second: CanvasBlock = { ...first, id: 'two', title: 'Second', content: 'Second passage', file: 'two.md', x: 500 };
const third: CanvasBlock = { ...first, id: 'three', title: 'Third', file: 'three.md', x: 1000 };
function model(overrides: Partial<AppDialogModel> = {}): AppDialogModel {
  return {
    dialog: 'block', setDialog: vi.fn(), busy: false, error: '', setError: vi.fn(),
    canvas: { id: 'canvas', name: 'Docs', workspaceId: 'team', blocks: [first, second, third] }, canvasId: 'canvas', crossLinkLabels: {}, showChat: false,
    draftName: '', setDraftName: vi.fn(), createNamed: vi.fn(), canvasToDelete: { id: 'canvas', name: 'Docs', workspaceId: 'team' },
    workspaceToDelete: { id: 'team', name: 'Team', canvases: [{ id: 'canvas', name: 'Docs' }] }, deleteCanvas: vi.fn(), deleteWorkspace: vi.fn(),
    settings: { provider: 'openrouter', model: 'test', systemPrompt: '', hasApiKey: false }, setSettings: vi.fn(), saveSettings: vi.fn(), openActivityHistory: vi.fn(),
    draftBlock: { id: first.id, title: first.title, kind: first.kind, content: first.content, contentHash: first.contentHash }, setDraftBlock: vi.fn(),
    draftLock: undefined, takeOverLock: vi.fn(), saveBlock: vi.fn(event => event.preventDefault()), importEditedFile: vi.fn(), deleteBlock: vi.fn(), updateBlock: vi.fn(), openDocumentAssistant: vi.fn(),
    versionBlockId: 'one', versionRevision: 'abc123', refreshAfterVersionChange: vi.fn(), readerId: 'one', sourceFocus: null,
    showReaderDocument: vi.fn(), closeReader: vi.fn(), openVersionHistory: vi.fn(), openBlock: vi.fn(), openCrossLink: vi.fn(), ...overrides,
  };
}
function EditorHarness({ initial, overrides = {} }: { initial: BlockDraft; overrides?: Partial<AppDialogModel> }) {
  const [draftBlock, setDraftBlock] = useState(initial);
  return <ModalOverlay model={model({ ...overrides, draftBlock, setDraftBlock })}/>;
}

 describe('dialog routing and recovery', () => {
  it('creates a workspace and canvas with the right names and submits or cancels', () => {
    const createNamed = vi.fn(event => event.preventDefault());
    const setDialog = vi.fn(); const setDraftName = vi.fn();
    const current = model({ dialog: 'workspace', createNamed, setDialog, setDraftName });
    const view = render(<ModalOverlay model={current}/>);
    expect(screen.getByRole('heading', { name: 'New workspace' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Workspace name' }), { target: { value: 'Research' } });
    expect(setDraftName).toHaveBeenCalledWith('Research');
    fireEvent.submit(screen.getByRole('textbox', { name: 'Workspace name' }).closest('form')!);
    expect(createNamed).toHaveBeenCalledOnce();
    view.rerender(<ModalOverlay model={{ ...current, dialog: 'canvas' }}/>);
    expect(screen.getByRole('heading', { name: 'New canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(setDialog).toHaveBeenCalledWith(null);
  });

  it('delegates settings cancel and history to the dialog model', () => {
    const current = model({ dialog: 'settings' });
    render(<ModalOverlay model={current}/>);
    expect(screen.getByRole('dialog').classList.contains('settings-modal')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Settings history' }));
    expect(current.openActivityHistory).toHaveBeenCalledWith('canvas', 'one', 'revision');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel settings' }));
    expect(current.setDialog).toHaveBeenCalledWith(null);
  });

  it('opens the selected version and refreshes its saved content, tolerating a missing document', () => {
    const current = model({ dialog: 'versions' }); const view = render(<ModalOverlay model={current}/>);
    expect(screen.getByText('History for First at abc123')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved version' }));
    expect(current.refreshAfterVersionChange).toHaveBeenCalledOnce();
    view.rerender(<ModalOverlay model={{ ...current, versionBlockId: 'missing' }}/>);
    expect(screen.queryByText(/History for/)).toBeNull();
    view.rerender(<ModalOverlay model={{ ...current, canvas: null }}/>);
    expect(screen.queryByText(/History for/)).toBeNull();
  });

  it.each(['delete-canvas', 'delete-workspace'] as const)('keeps %s retry and cancel visible with the failed target', dialog => {
    const current = model({ dialog, error: 'Delete failed' }); const view = render(<ModalOverlay model={current}/>);
    expect(screen.getByRole('alert').textContent).toBe('Delete failed');
    expect(screen.getByText(/This cannot be undone/).textContent).toContain(dialog === 'delete-workspace' ? 'its 1 canvas,' : 'all its documents');
    fireEvent.click(screen.getByRole('button', { name: dialog === 'delete-canvas' ? 'Delete canvas' : 'Delete workspace' }));
    expect(dialog === 'delete-canvas' ? current.deleteCanvas : current.deleteWorkspace).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(current.setDialog).toHaveBeenCalledWith(null);
    view.rerender(<ModalOverlay model={{ ...current, busy: true, error: '', workspaceToDelete: { id: 'team', name: 'Team', canvases: [] } }}/>);
    expect((screen.getByRole('button', { name: 'Deleting…' }) as HTMLButtonElement).disabled).toBe(true);
    if (dialog === 'delete-workspace') expect(screen.getByText(/This cannot be undone/).textContent).toContain('0 canvases');
    view.rerender(<ModalOverlay model={{ ...current, canvasToDelete: null, workspaceToDelete: null }}/>);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('does not close on inner clicks or ordinary keys, and closes on the clean backdrop', () => {
    const current = model({ dialog: 'canvas' }); const { container } = render(<ModalOverlay model={current}/>);
    const input = screen.getByRole('textbox', { name: 'Canvas name' });
    fireEvent.mouseDown(input); fireEvent.keyDown(input, { key: 'a' });
    input.focus(); expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(current.setDialog).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.querySelector('.overlay')!);
    expect(current.setDialog).toHaveBeenCalledWith(null);
  });

  it('contains Tab within the unsaved warning while the assistant remains open', () => {
    render(<EditorHarness initial={{ title: 'Original', kind: 'markdown', content: 'old' }} overrides={{ showChat: true }}/>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Changed' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Escape' });
    const prompt = screen.getByRole('alertdialog'); const save = within(prompt).getByRole('button', { name: 'Save changes' });
    save.focus(); fireEvent.keyDown(save, { key: 'Tab' });
    expect(document.activeElement).toBe(within(prompt).getByRole('button', { name: 'Continue editing' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(save);
  });
});

describe('document editor', () => {
  it('switches back from preview with the advertised keyboard shortcut and retains keyboard focus', () => {
    render(<EditorHarness initial={{ title: 'Keyboard draft', content: 'Draft', kind: 'markdown' }}/>);
    const source = screen.getByRole('textbox', { name: 'Markdown source' }); source.focus();
    fireEvent.keyDown(source, { key: 'e', metaKey: true });
    expect(screen.queryByRole('textbox', { name: 'Markdown source' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'preview' }));
    fireEvent.keyDown(document.activeElement!, { key: 'e', ctrlKey: true });
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'source' }));
    fireEvent.keyDown(document.activeElement!, { key: 'x', metaKey: true });
    fireEvent.keyDown(document.activeElement!, { key: 'e' });
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toBeTruthy();
  });

  it('edits source, loader and title, switches views and routes preview changes and errors', () => {
    const setError = vi.fn(); render(<EditorHarness initial={{ title: '', content: 'Draft', kind: 'markdown' }} overrides={{ setError, canvas: null }}/>);
    expect(screen.getByRole('heading', { name: 'New document' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'split' }));
    expect(screen.getByRole('region', { name: 'Document preview' }).textContent).toContain('Untitled: Draft');
    fireEvent.click(screen.getByRole('button', { name: 'Change preview' }));
    expect((screen.getByRole('textbox', { name: 'Markdown source' }) as HTMLTextAreaElement).value).toBe('Preview changed');
    fireEvent.click(screen.getByRole('button', { name: 'Keep preview' })); fireEvent.click(screen.getByRole('button', { name: 'Clear optional patch' }));
    expect((screen.getByRole('textbox', { name: 'Markdown source' }) as HTMLTextAreaElement).value).toBe('Preview changed');
    fireEvent.click(screen.getByRole('button', { name: 'Preview error' })); expect(setError).toHaveBeenCalledWith('Preview unavailable');
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown source' }), { target: { value: 'Typed draft' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Named draft' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Loader' }), { target: { value: 'slides' } });
    expect(screen.getByRole('region', { name: 'Document preview' }).textContent).toContain('Named draft');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Markdown source' }), { key: 'e', metaKey: true });
    expect(screen.queryByRole('textbox', { name: 'Markdown source' })).toBeNull();
    expect(screen.getByText('Live preview')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'source' })); expect(screen.queryByRole('region', { name: 'Document preview' })).toBeNull();
  });

  it('keeps a newer saved revision safe until the user explicitly loads it', () => {
    render(<EditorHarness initial={{ id: 'one', title: 'Old draft', kind: 'markdown', content: 'old', contentHash: 'old' }}/>);
    expect((screen.getByRole('button', { name: 'Save document' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Load saved version' }));
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('First');
    expect((screen.getByRole('textbox', { name: 'Markdown source' }) as HTMLTextAreaElement).value).toBe(first.content);
    expect((screen.getByRole('button', { name: 'Save document' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows another editor lock with optional notes and routes take-over and delete actions', () => {
    const current = model({ draftLock: { owner: 'Teammate', expiresAt: '2026-10-01T12:00:00Z', note: 'Checking sources' } });
    const view = render(<ModalOverlay model={current}/>);
    expect(screen.getByRole('status').textContent).toContain('Checking sources');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' })); expect(current.takeOverLock).toHaveBeenCalledWith('one');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' })); expect(current.deleteBlock).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Ask Symbi' })); expect(current.openDocumentAssistant).toHaveBeenCalledOnce();
    view.rerender(<ModalOverlay model={{ ...current, draftLock: { ...current.draftLock!, note: undefined } }}/>);
    expect(screen.getByRole('status').textContent).not.toContain(' — ');
    view.rerender(<ModalOverlay model={{ ...current, draftBlock: { title: 'New', content: '', kind: 'markdown' } }}/>);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disables save while importing an edited file and restores it after completion', async () => {
    let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
    const importEditedFile = vi.fn(() => promise); const current = model({ importEditedFile });
    render(<ModalOverlay model={current}/>);
    expect(screen.getByRole('link', { name: 'Download .md' }).getAttribute('href')).toBe('/api/canvases/canvas/blocks/one/download');
    const upload = screen.getByLabelText('Upload edited file');
    fireEvent.change(upload, { target: { files: [] } }); expect(importEditedFile).not.toHaveBeenCalled();
    fireEvent.change(upload, { target: { files: null } }); expect(importEditedFile).not.toHaveBeenCalled();
    const file = new File(['edited'], 'one.md', { type: 'text/markdown' }); fireEvent.change(upload, { target: { files: [file] } });
    expect(importEditedFile).toHaveBeenCalledWith(file);
    expect((screen.getByRole('button', { name: 'Loading file…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve()); expect((screen.getByRole('button', { name: 'Save document' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('explains website preview before saving and after source changes', () => {
    const view = render(<EditorHarness initial={{ title: 'Website', content: 'Website source', kind: 'website' }}/>);
    fireEvent.click(screen.getByRole('button', { name: 'preview' })); expect(screen.getByText(/Save this website block/)).toBeTruthy();
    view.unmount(); render(<EditorHarness initial={{ id: 'website', title: 'Website', content: 'Website source', kind: 'website' }}/>);
    fireEvent.click(screen.getByRole('button', { name: 'preview' })); expect(screen.getByText(/uses the last saved source/)).toBeTruthy();
  });
});

describe('reader navigation and cited context', () => {
  it('uses the normal document sequence, navigates with buttons and keys, and ignores editable keys', () => {
    const current = model({ readerId: 'two', showChat: true, dialog: null });
    const view = render(<FullPageReader model={current}/>);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('false');
    expect(screen.getByRole('navigation', { name: 'Documents on this canvas' })).toBeTruthy();
    expect(screen.getByText('2 / 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous document' })); expect(current.showReaderDocument).toHaveBeenLastCalledWith('one');
    fireEvent.click(screen.getByRole('button', { name: 'Next document' })); expect(current.showReaderDocument).toHaveBeenLastCalledWith('three');
    fireEvent.click(screen.getByRole('button', { name: /Previous\s*‹ First/ })); expect(current.showReaderDocument).toHaveBeenLastCalledWith('one');
    fireEvent.click(screen.getByRole('button', { name: /Next\s*Third/ })); expect(current.showReaderDocument).toHaveBeenLastCalledWith('three');
    fireEvent.change(screen.getByRole('combobox', { name: 'Jump to document' }), { target: { value: 'one' } }); expect(current.showReaderDocument).toHaveBeenLastCalledWith('one');
    for (const key of ['ArrowLeft', '[']) { fireEvent.keyDown(window, { key }); expect(current.showReaderDocument).toHaveBeenLastCalledWith('one'); }
    for (const key of ['ArrowRight', ']']) { fireEvent.keyDown(window, { key }); expect(current.showReaderDocument).toHaveBeenLastCalledWith('three'); }
    vi.mocked(current.showReaderDocument).mockClear(); fireEvent.keyDown(window, { key: 'x' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowRight' }); expect(current.showReaderDocument).not.toHaveBeenCalled();
    view.rerender(<FullPageReader model={{ ...current, dialog: 'versions' }}/>); fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(current.showReaderDocument).not.toHaveBeenCalled();
    view.rerender(<FullPageReader model={{ ...current, readerId: 'three' }}/>); fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(current.showReaderDocument).not.toHaveBeenCalled();
    view.rerender(<FullPageReader model={{ ...current, readerId: 'missing' }}/>); expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<FullPageReader model={{ ...current, canvas: null }}/>); expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('routes history, edit, assistant and close without losing the document identity', () => {
    const current = model(); render(<FullPageReader model={current}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Ask Symbi' })); expect(current.openDocumentAssistant).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'File history' })); expect(current.openVersionHistory).toHaveBeenCalledWith(first);
    expect(current.closeReader).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' })); expect(current.openBlock).toHaveBeenCalledWith(first);
    fireEvent.keyDown(document.body, { key: 'Escape' }); expect(current.closeReader).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '← Back to canvas' })); expect(current.closeReader).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('link', { name: 'Download .md' }).getAttribute('href')).toContain('/one/download');
    fireEvent.click(screen.getByRole('button', { name: 'Change preview' })); expect(current.updateBlock).toHaveBeenCalledWith('one', { content: 'Preview changed' });
    fireEvent.click(screen.getByRole('button', { name: 'Preview error' })); expect(current.setError).toHaveBeenCalledWith('Preview unavailable');
  });

  it('keeps a summary readable while loading, reports failures, and retries the current source', async () => {
    let finish!: (response: Response) => void;
    const loading = new Promise<Response>(resolve => { finish = resolve; });
    const sourceResponses = [loading, Promise.resolve(Response.json({ error: 'Source temporarily unavailable' }, { status: 503 })),
      Promise.resolve(Response.json(first))];
    let sourceReads = 0;
    const fetcher = vi.fn<typeof fetch>(async input => {
      if (String(input).includes('/jev/documents/')) return Response.json({ canvasId: 'canvas', blockId: 'one',
        contentHash: first.contentHash, durable: false, actions: [] });
      return sourceResponses[sourceReads++] ?? Response.json({ error: 'Unexpected source read' }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetcher);
    const summary = { ...first, content: '', contentLoaded: false };
    const current = model({ canvas: { id: 'canvas', name: 'Docs', workspaceId: 'team', blocks: [summary] } });
    const view = render(<FullPageReader model={current}/>);
    expect(screen.getByRole('status').textContent).toContain('Loading document');
    expect(screen.getByRole('dialog', { name: 'First full page' })).toBeTruthy();
    await act(async () => { finish(Response.json(first)); });
    expect(screen.getByText('First: First passage')).toBeTruthy();
    const review = screen.getByRole('region', { name: 'Jev document decisions' });
    const documentContent = screen.getByText('First: First passage');
    expect(documentContent.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    view.unmount(); render(<FullPageReader model={current}/>);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Source temporarily unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading document' }));
    await waitFor(() => expect(screen.getByText('First: First passage')).toBeTruthy());
    expect(sourceReads).toBe(3);
  });

  it('distinguishes matching, approximate, stale and irrelevant cited passages', () => {
    const source: NonNullable<AppDialogModel['sourceFocus']> = { kind: 'document', canvasId: 'canvas', blockId: 'one', title: 'First', excerpt: 'First passage' };
    const current = model({ sourceFocus: source }); const view = render(<FullPageReader model={current}/>);
    expect(screen.getByText(/passage appears in the current/)).toBeTruthy();
    view.rerender(<FullPageReader model={{ ...current, sourceFocus: { ...source, excerpt: 'Approximate' } }}/>); expect(screen.getByText(/excerpt is approximate/)).toBeTruthy();
    view.rerender(<FullPageReader model={{ ...current, sourceFocus: { ...source, contentHash: 'h1' } }}/>); expect(screen.getByText(/passage appears/)).toBeTruthy();
    view.rerender(<FullPageReader model={{ ...current, sourceFocus: { ...source, contentHash: 'old' } }}/>); expect(screen.getByText(/changed since Chat/)).toBeTruthy();
    for (const invalid of [{ blockId: 'two' }, { canvasId: 'other' }, { excerpt: '' }]) {
      view.rerender(<FullPageReader model={{ ...current, sourceFocus: { ...source, ...invalid } }}/>);
      expect(screen.queryByLabelText('Source context from Chat')).toBeNull();
    }
  });

  it('checks Symbi Reflex generations and exact offsets before presenting a saved passage as current', () => {
    const document = { ...first, incarnation: 'inc', sourceGeneration: 3, metadataRevision: 5 };
    const source: NonNullable<AppDialogModel['sourceFocus']> = { kind: 'document', canvasId: 'canvas', blockId: 'one',
      title: 'First', excerpt: 'First passage', origin: 'Symbi Reflex', contentHash: document.contentHash,
      incarnation: 'inc', sourceGeneration: 3, metadataRevision: 5, start: 0, end: 'First passage'.length };
    const current = model({ sourceFocus: source, canvas: { id: 'canvas', name: 'Docs', workspaceId: 'team', blocks: [document] } });
    const view = render(<FullPageReader model={current}/>);
    expect(screen.getByLabelText('Source context from Symbi Reflex')).toBeTruthy();
    expect(screen.getByText(/passage appears in the current/)).toBeTruthy();
    for (const changed of [{ incarnation: 'replacement' }, { sourceGeneration: 2 }, { metadataRevision: 4 }, { contentHash: 'old' }]) {
      view.rerender(<FullPageReader model={{ ...current, sourceFocus: { ...source, ...changed } }}/>);
      expect(screen.getByText(/changed since Symbi Reflex/)).toBeTruthy();
    }
    for (const offsets of [{ start: undefined }, { end: undefined }, { start: -1 }, { start: 0.5 }, { end: 0.5 },
      { start: source.end }, { end: 0 }, { start: 1 }, { end: 999 }]) {
      view.rerender(<FullPageReader model={{ ...current, sourceFocus: { ...source, ...offsets } }}/>);
      expect(screen.getByText(/excerpt is approximate/)).toBeTruthy();
    }
  });

  it('shows foreign locks and unresolved related links without optional relation labels', () => {
    const document = { ...first, lock: { owner: 'Other agent', expiresAt: '2026-10-01T12:00:00Z' }, crossLinks: [{ canvasId: 'remote', blockId: 'doc' }] };
    const current = model({ canvas: { id: 'canvas', name: 'Docs', workspaceId: 'team', blocks: [document] }, crossLinkLabels: undefined } as unknown as Partial<AppDialogModel>);
    const view = render(<FullPageReader model={current}/>);
    expect(screen.getByText(/Other agent is editing/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open remote · doc' })); expect(current.openCrossLink).toHaveBeenCalledWith('remote', 'doc');
    view.rerender(<FullPageReader model={{ ...current, crossLinkLabels: { 'remote:doc': 'Implementation' },
      canvas: { ...current.canvas!, blocks: [{ ...document, crossLinks: [{ canvasId: 'remote', blockId: 'doc', relation: 'decision_for' }] }] } }}/>);
    expect(screen.getByText('decision for')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Implementation' })); expect(current.openCrossLink).toHaveBeenLastCalledWith('remote', 'doc');
    view.rerender(<FullPageReader model={{ ...current, canvas: { ...current.canvas!, blocks: [{ ...document, lock: { ...document.lock, owner: browserActor }, crossLinks: undefined }] } }}/>);
    expect(screen.queryByText(/is editing/)).toBeNull(); expect(screen.queryByLabelText('Related on other canvases')).toBeNull();
  });
});
