// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { AppDialogModel } from './app-dialog-contract';
import { FullPageReader, ModalOverlay } from './AppDialogs';

vi.mock('./MarkdownEditor', () => ({ MarkdownEditor: () => <textarea aria-label="Markdown source"/>, ViewToggle: () => <div/> }));

vi.mock('./Loaders', async () => {
  const React = await import('react');
  return { BlockContent: ({ block }: { block: CanvasBlock }) => React.createElement('div', {}, block.content) };
});

function block(crossLinks: CanvasBlock['crossLinks'] = []): CanvasBlock {
  return { id: 'rate-limits', title: 'API rate limits', content: '# Rate limits', file: 'docs/rate-limits.md',
    kind: 'markdown', x: 0, y: 0, width: 400, height: 320, links: [], crossLinks };
}

function modelFor(document: CanvasBlock, labels: Record<string, string> = {}) {
  const canvas: CanvasDocument = { id: 'api', name: 'API', workspaceId: 'team', blocks: [document] };
  const openCrossLink = vi.fn();
  const model = { canvas, canvasId: canvas.id, readerId: document.id, crossLinkLabels: labels,
    openCrossLink, closeReader: vi.fn(), showReaderDocument: vi.fn(), openVersionHistory: vi.fn(),
    openBlock: vi.fn(), updateBlock: vi.fn(), setError: vi.fn() } as unknown as AppDialogModel;
  return { model, openCrossLink };
}

afterEach(cleanup);

describe('full-page reader cross-canvas links', () => {
  it('lists related documents with resolved labels and opens the selected target', () => {
    const { model, openCrossLink } = modelFor(block([
      { canvasId: 'billing', blockId: 'client', relation: 'implements' },
      { canvasId: 'operations', blockId: 'runbook', relation: 'prerequisite' },
    ]), { 'billing:client': 'Billing · Billing client', 'operations:runbook': 'Operations · Retry runbook' });
    render(<FullPageReader model={model}/>);
    const related = screen.getByRole('complementary', { name: 'Related on other canvases' });
    expect(within(related).getByText('implements')).toBeTruthy();
    fireEvent.click(within(related).getByRole('button', { name: 'Open Billing · Billing client' }));
    expect(openCrossLink).toHaveBeenCalledWith('billing', 'client');
    expect(within(related).getByRole('button', { name: 'Open Operations · Retry runbook' })).toBeTruthy();
  });

  it('omits the related section when the document has no cross links', () => {
    const { model } = modelFor(block());
    render(<FullPageReader model={model}/>);
    expect(screen.queryByRole('complementary', { name: 'Related on other canvases' })).toBeNull();
  });

  it('shows cited context and warns when the checked content has changed', () => {
    const document = { ...block(), contentHash: 'new-hash' };
    const { model } = modelFor(document);
    model.sourceFocus = { kind: 'document', canvasId: 'api', blockId: document.id, title: document.title,
      excerpt: 'Rate limits', contentHash: 'old-hash' };
    render(<FullPageReader model={model}/>);
    const source = screen.getByLabelText('Source context from Chat');
    expect(within(source).getByText('Rate limits')).toBeTruthy();
    expect(within(source).getByText(/changed since Chat checked/)).toBeTruthy();
  });
});

describe('ModalOverlay', () => {
  it('contains keyboard focus and returns it to the trigger after closing', () => {
    function Harness() {
      const [dialog, setDialog] = useState<'canvas' | null>(null);
      const model = { dialog, setDialog, busy: false, draftBlock: {}, draftName: '', setDraftName: vi.fn(), createNamed: vi.fn() } as unknown as AppDialogModel;
      return <><button onClick={() => setDialog('canvas')}>Open</button>{dialog && <ModalOverlay model={model}/>}</>;
    }
    render(<Harness/>);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Create new' });
    const create = within(dialog).getByRole('button', { name: 'Create' });
    create.focus();
    fireEvent.keyDown(create, { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close dialog' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(create);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    expect(document.activeElement).toBe(trigger);
  });

  it('offers save, discard, and continue editing when Escape closes a dirty editor', () => {
    function Harness() {
      const [dialog, setDialog] = useState<'block' | null>(null);
      const [draftBlock, setDraftBlock] = useState({ id: 'doc', title: 'Original', content: 'text', kind: 'markdown' as const });
      const saveBlock = vi.fn((event: React.FormEvent) => event.preventDefault());
      const model = { dialog, setDialog, draftBlock, setDraftBlock, saveBlock, busy: false, showChat: false,
        canvas: { blocks: [] }, canvasId: 'canvas', draftLock: null, importEditedFile: vi.fn(), deleteBlock: vi.fn(),
        takeOverLock: vi.fn(), openDocumentAssistant: vi.fn() } as unknown as AppDialogModel;
      return <><button onClick={() => setDialog('block')}>Edit</button>{dialog && <ModalOverlay model={model}/>}</>;
    }
    render(<Harness/>);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Changed' } });
    fireEvent.keyDown(title, { key: 'Escape' });
    const prompt = screen.getByRole('alertdialog', { name: 'Unsaved changes' });
    expect(within(prompt).getByRole('button', { name: 'Save changes' })).toBeTruthy();
    fireEvent.click(within(prompt).getByRole('button', { name: 'Continue editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('dialog', { name: 'Document editor' })).toBeNull();
  });

  it('keeps a busy dialog open after Escape or backdrop clicks', () => {
    const setDialog = vi.fn();
    const model = { dialog: 'canvas', setDialog, busy: true, draftBlock: {}, draftName: '',
      setDraftName: vi.fn(), createNamed: vi.fn() } as unknown as AppDialogModel;
    const { container, rerender } = render(<ModalOverlay model={model}/>);
    const dialog = screen.getByRole('dialog', { name: 'Create new' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.mouseDown(container.querySelector('.modal-overlay')!);
    expect(setDialog).not.toHaveBeenCalled();
    rerender(<ModalOverlay model={{ ...model, busy: false }}/>);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(setDialog).toHaveBeenCalledExactlyOnceWith(null);
    expect(dialog).toBeTruthy();
  });

  it('lets Escape dismiss the unsaved warning and Save changes submit the draft', () => {
    const saveBlock = vi.fn((event: React.FormEvent) => event.preventDefault());
    function Harness() {
      const [dialog, setDialog] = useState<'block' | null>('block');
      const [draftBlock, setDraftBlock] = useState({ id: 'doc', title: 'Original', content: 'text', kind: 'markdown' as const });
      const model = { dialog, setDialog, draftBlock, setDraftBlock, saveBlock, busy: false, showChat: false,
        canvas: { blocks: [] }, canvasId: 'canvas', draftLock: null, importEditedFile: vi.fn(), deleteBlock: vi.fn(),
        takeOverLock: vi.fn(), openDocumentAssistant: vi.fn() } as unknown as AppDialogModel;
      return dialog && <ModalOverlay model={model}/>;
    }
    render(<Harness/>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    const warning = screen.getByRole('alertdialog', { name: 'Unsaved changes' });
    fireEvent.keyDown(warning, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(saveBlock).toHaveBeenCalledOnce();
  });
});

describe('editor keyboard recovery', () => {
  it('returns focus to the editor field after dismissing an unsaved warning', () => {
    function Harness() {
      const [draftBlock, setDraftBlock] = useState({ title: 'Original', content: 'text', kind: 'markdown' as const });
      const model = { dialog: 'block', setDialog: vi.fn(), draftBlock, setDraftBlock, saveBlock: vi.fn(), busy: false, showChat: false,
        canvas: { blocks: [] }, canvasId: 'canvas', importEditedFile: vi.fn(), deleteBlock: vi.fn(),
        takeOverLock: vi.fn(), openDocumentAssistant: vi.fn() } as unknown as AppDialogModel;
      return <ModalOverlay model={model}/>;
    }
    render(<Harness/>);
    const title = screen.getByRole('textbox', { name: 'Title' });
    title.focus();
    fireEvent.change(title, { target: { value: 'Changed' } });
    fireEvent.keyDown(title, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue editing' }));
    expect(document.activeElement).toBe(title);
  });

  it('allows Tab to leave the nonmodal editor when the document assistant is open', () => {
    const model = { dialog: 'block', setDialog: vi.fn(), draftBlock: { title: 'Original', content: 'text', kind: 'markdown' },
      setDraftBlock: vi.fn(), saveBlock: vi.fn(), busy: false, showChat: true, canvas: { blocks: [] }, canvasId: 'canvas',
      importEditedFile: vi.fn(), deleteBlock: vi.fn(), takeOverLock: vi.fn(), openDocumentAssistant: vi.fn() } as unknown as AppDialogModel;
    render(<ModalOverlay model={model}/>);
    const dialog = screen.getByRole('dialog', { name: 'Document editor' });
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    const save = within(dialog).getByRole('button', { name: 'Save document' });
    save.focus();
    expect(fireEvent.keyDown(save, { key: 'Tab' })).toBe(true);
  });
});
