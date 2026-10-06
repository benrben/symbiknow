// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ModalOverlay } from './AppDialogs';
import { useAppModel } from './app-model';
import type { CanvasBlock, CanvasDocument, WorkspaceSummary } from '../shared/types';

vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="Markdown source" value={value} onChange={event => onChange(event.currentTarget.value)}/>,
  ViewToggle: () => <div/>,
}));

function server() {
  const saved: CanvasBlock = { id: 'doc', title: 'Saved note', content: 'Saved content', contentHash: 'original', kind: 'markdown', file: 'doc.md', x: 0, y: 0, width: 400, height: 320, links: [] };
  const canvas: CanvasDocument = { id: 'docs', name: 'Docs', workspaceId: 'team', blocks: [saved] };
  const workspaces: WorkspaceSummary[] = [{ id: 'team', name: 'Team', canvases: [{ id: 'docs', name: 'Docs' }] }];
  const canvases = new Map([[canvas.id, canvas]]);
  const writes: { path: string; payload: unknown }[] = []; const reads: string[] = [];
  let failSave = true; let failWorkspace = true;
  const fetchResponse = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace('?summary=1', ''); const method = init?.method ?? 'GET';
    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === 'GET') reads.push(path); else writes.push({ path, payload });
    if (path === '/api/settings') return Response.json({ provider: 'openrouter', model: 'test', systemPrompt: '', hasApiKey: false, hasJevApiKey: false, reviewers: '' });
    if (path === '/api/workspaces' && method === 'GET') return Response.json(workspaces);
    if (path === '/api/workspaces' && method === 'POST') {
      if (failWorkspace) { failWorkspace = false; return Response.json({ error: 'Workspace could not be created' }, { status: 503 }); }
      const workspace = { id: 'research', name: payload.name, canvases: [] }; workspaces.push(workspace); return Response.json(workspace);
    }
    if (path === '/api/workspaces/research/canvases') {
      const created = { id: 'research-docs', name: payload.name, workspaceId: 'research', blocks: [] }; canvases.set(created.id, created);
      workspaces[1].canvases.push({ id: created.id, name: created.name }); return Response.json(created);
    }
    if (path === '/api/canvases/docs/blocks/doc' && method === 'GET') return Response.json(saved);
    if (method === 'GET' && path.startsWith('/api/canvases/')) {
      const current = canvases.get(path.slice('/api/canvases/'.length));
      if (current) return Response.json(current);
    }
    if (path === '/api/canvases/docs/blocks/doc' && method === 'PUT') {
      if (failSave) { failSave = false; return Response.json({ error: 'Saved content is unchanged. Retry saving.' }, { status: 503 }); }
      Object.assign(saved, payload, { contentHash: 'saved-after-edit' }); return Response.json(saved);
    }
    return Response.json({ error: 'Unexpected request: ' + method + ' ' + path }, { status: 404 });
  };
  return { fetchResponse, saved, canvas, workspaces, writes, reads };
}
function Harness() {
  const model = useAppModel();
  return <><h1>{model.canvas?.name ?? 'Loading'}</h1>
    <button disabled={!model.canvas} onClick={() => model.openBlock(model.canvas!.blocks[0])}>Edit saved note</button>
    <button onClick={() => model.openNamedDialog('workspace')}>New workspace</button>
    <output aria-label="Saved documents">{model.canvas?.blocks.map(block => `${block.title}: ${block.content}`).join('\n')}</output>
    {model.dialog && <ModalOverlay model={model}/>}</>;
}
beforeEach(() => { window.localStorage.clear(); window.history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('dialog API validation and recovery', () => {
  it('keeps failed saves visible inside the editor, retries, and reads the persisted revision back', async () => {
    const fixture = server(); vi.stubGlobal('fetch', vi.fn(fixture.fetchResponse)); render(<Harness/>);
    await screen.findByRole('heading', { name: 'Docs' }); fireEvent.click(screen.getByRole('button', { name: 'Edit saved note' }));
    const dialog = screen.getByRole('dialog', { name: 'Block editor' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), { target: { value: '  Revised note  ' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Markdown source' }), { target: { value: 'Revised persisted content' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save block' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Saved content is unchanged. Retry saving.');
    expect(fixture.saved.title).toBe('Saved note'); expect(fixture.saved.content).toBe('Saved content');
    expect((within(dialog).getByRole('button', { name: 'Save block' }) as HTMLButtonElement).disabled).toBe(false);
    const readsBefore = fixture.reads.length; fireEvent.click(within(dialog).getByRole('button', { name: 'Save block' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('Saved documents').textContent).toBe('Revised note: Revised persisted content');
    expect(fixture.writes.at(-1)).toEqual({ path: '/api/canvases/docs/blocks/doc', payload: { title: 'Revised note', content: 'Revised persisted content', kind: 'markdown', expectedContentHash: 'original' } });
    expect(fixture.reads.slice(readsBefore)).toContain('/api/canvases/docs');
    fireEvent.click(screen.getByRole('button', { name: 'Edit saved note' }));
    expect((screen.getByRole('textbox', { name: 'Markdown source' }) as HTMLTextAreaElement).value).toBe('Revised persisted content');
  });

  it('validates blank names, retains a failed workspace draft, then reads the created workspace and canvas back', async () => {
    const fixture = server(); vi.stubGlobal('fetch', vi.fn(fixture.fetchResponse)); render(<Harness/>);
    await screen.findByRole('heading', { name: 'Docs' }); fireEvent.click(screen.getByRole('button', { name: 'New workspace' }));
    const dialog = screen.getByRole('dialog', { name: 'Create new' }); const input = within(dialog).getByRole('textbox', { name: 'Workspace name' });
    fireEvent.change(input, { target: { value: '  ' } }); fireEvent.submit(input.closest('form')!); expect(fixture.writes).toHaveLength(0);
    fireEvent.change(input, { target: { value: '  Research  ' } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Workspace could not be created');
    expect((input as HTMLInputElement).value).toBe('  Research  '); expect(fixture.workspaces).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' })); await screen.findByRole('heading', { name: 'Untitled canvas' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fixture.workspaces[1]).toEqual({ id: 'research', name: 'Research', canvases: [{ id: 'research-docs', name: 'Untitled canvas' }] });
    expect(fixture.reads).toContain('/api/canvases/research-docs');
  });

  it('recovers from an edited-file read failure without replacing the draft and accepts a corrected file', async () => {
    const fixture = server(); vi.stubGlobal('fetch', vi.fn(fixture.fetchResponse)); render(<Harness/>);
    await screen.findByRole('heading', { name: 'Docs' }); fireEvent.click(screen.getByRole('button', { name: 'Edit saved note' }));
    const dialog = screen.getByRole('dialog', { name: 'Block editor' }); const input = within(dialog).getByLabelText('Upload edited file');
    const broken = new File(['broken'], 'edited.md'); Object.defineProperty(broken, 'text', { value: async () => { throw new Error('File could not be read'); } });
    fireEvent.change(input, { target: { files: [broken] } }); expect((await within(dialog).findByRole('alert')).textContent).toBe('File could not be read');
    expect((within(dialog).getByRole('textbox', { name: 'Markdown source' }) as HTMLTextAreaElement).value).toBe('Saved content');
    const fixed = new File(['corrected'], 'edited.md'); Object.defineProperty(fixed, 'text', { value: async () => 'Corrected local content' });
    fireEvent.change(input, { target: { files: [fixed] } });
    await waitFor(() => expect((within(dialog).getByRole('textbox', { name: 'Markdown source' }) as HTMLTextAreaElement).value).toBe('Corrected local content'));
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Save block' }) as HTMLButtonElement).disabled).toBe(false);
    expect(fixture.writes).toHaveLength(0); expect(fixture.saved.content).toBe('Saved content');
  });
});
