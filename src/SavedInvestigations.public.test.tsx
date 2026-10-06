// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import { InvestigationStore } from '../server/investigations';
import { useSavedInvestigations } from './useSavedInvestigations';
import { SavedInvestigations, type InvestigationRecord, type SavedInvestigationsProps } from './SavedInvestigations';

const nativeFetch = globalThis.fetch;
const servers: { server: Server; root: string }[] = [];
const keysName = 'symbiknow.investigation-keys.v1';
const record: InvestigationRecord = {
  id: 'saved-1', workspaceId: 'acme-team', canvasId: 'product-roadmap', title: 'Launch evidence', visibility: 'shared',
  messages: [{ role: 'user', content: 'What blocks release?' }, { role: 'assistant', content: 'Beta testing remains.' }],
  sourceRefs: [], proposalRefs: [], revision: 1, createdAt: '2026-09-28T10:00:00Z', updatedAt: '2026-09-28T10:00:00Z',
};
const snapshot = {
  turns: [{ id: 1, query: 'What blocks release?', answer: 'Beta testing remains.', sources: [], status: 'complete' as const }],
  edits: { added: [], changed: {}, deleted: [], addedEdges: [], deletedEdges: [] }, layout: 'roadmap' as const,
};
function props(overrides: Partial<SavedInvestigationsProps> = {}): SavedInvestigationsProps {
  return { workspaceId: record.workspaceId, canvasId: record.canvasId!, messages: record.messages, sourceRefs: [], proposalRefs: [], onOpen: vi.fn(), ...overrides };
}
function summary(value: InvestigationRecord) { return { ...value, messageCount: value.messages.length, sourceCount: value.sourceRefs.length, proposalCount: value.proposalRefs.length }; }
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function boundary(handler: (route: string, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => handler(String(input), init));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
function list(value: InvestigationRecord[] = [record]) { return Response.json({ investigations: value.map(summary) }); }
async function expand() {
  fireEvent.click(screen.getByText(/Saved investigations/));
  await screen.findByRole('textbox', { name: 'Investigation name' });
}
function name(value: string) { fireEvent.change(screen.getByRole('textbox', { name: 'Investigation name' }), { target: { value } }); }
function access(value: 'shared' | 'private') { fireEvent.change(screen.getByRole('combobox', { name: 'Investigation access' }), { target: { value } }); }
async function saveFinished(receipt: string) {
  await screen.findByText(receipt);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false));
}
async function openFirst() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
  await screen.findByLabelText('Opened investigation details');
}
beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const { server, root } of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('saved investigation asynchronous ownership', () => {
  it('does not restore a held investigation from the workspace that was left', async () => {
    const pending = held<Response>();
    const current = props();
    boundary(route => route.endsWith('/list') ? list() : pending.promise);
    const view = render(<SavedInvestigations {...current} />);
    await expand();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    view.rerender(<SavedInvestigations {...current} workspaceId="other-team" />);
    await act(async () => pending.resolve(Response.json(record)));
    expect(current.onOpen).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Opened investigation details')).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Investigation name' }) as HTMLInputElement).value).toBe('');
  });
  it('keeps the latest linked open request when earlier network reads finish later', async () => {
    const pending = held<Response>();
    const next = { ...record, id: 'saved-2', title: 'Later selection' };
    const current = props();
    boundary(route => route.endsWith('/list') ? list([record, next]) : route.endsWith('/saved-1') ? pending.promise : Response.json(next));
    const view = render(<SavedInvestigations {...current} openRequest={{ id: record.id, sequence: 1 }} />);
    view.rerender(<SavedInvestigations {...current} openRequest={{ id: next.id, sequence: 2 }} />);
    await screen.findByText('Opened Later selection. Save changes to update this investigation.');
    await act(async () => pending.resolve(Response.json(record)));
    expect(current.onOpen).toHaveBeenCalledTimes(1);
    expect(current.onOpen).toHaveBeenCalledWith(next);
    expect((screen.getByRole('textbox', { name: 'Investigation name' }) as HTMLInputElement).value).toBe(next.title);
  });
  it('does not apply a completed save to a workspace that was left', async () => {
    const pending = held<Response>();
    const current = props({ onSaved: vi.fn() });
    boundary(route => route.endsWith('/list') ? list([]) : pending.promise);
    const view = render(<SavedInvestigations {...current} />);
    await expand();
    await screen.findByText('No saved investigations yet.');
    name('Earlier workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    view.rerender(<SavedInvestigations {...current} workspaceId="other-team" />);
    await act(async () => pending.resolve(Response.json({ investigation: record })));
    expect(current.onSaved).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Opened investigation details')).toBeNull();
    expect(screen.queryByText('Saved Launch evidence (private).')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save investigation' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('retries source freshness when the same investigation revision is reopened', async () => {
    let checks = 0;
    const saved = { ...record, sourceRefs: [{ canvasId: 'product-roadmap', blockId: 'beta', contentHash: 'aaaaaaaaaaaaaaaa' }] };
    boundary(route => route.endsWith('/list') ? list([saved]) : route.includes('/canvases/') ? ++checks === 1 ? Response.json({ error: 'Freshness unavailable' }, { status: 503 }) : Response.json({ id: 'product-roadmap', blocks: [{ id: 'beta', title: 'Beta', content: 'Current beta', contentHash: 'bbbbbbbbbbbbbbbb' }] }) : Response.json(saved));
    render(<SavedInvestigations {...props()} />);
    await expand();
    await openFirst();
    await screen.findByText(/Source freshness could not be checked/);
    expect(screen.queryByText(/Checking saved sources/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByText(/source changed since this investigation was saved/);
    expect(checks).toBe(2);
    expect(screen.queryByText(/Source freshness could not be checked/)).toBeNull();
  });
  it('clears the previous private key warning when starting a new investigation', async () => {
    const saved = { ...record, visibility: 'private' as const };
    boundary(route => route.endsWith('/list') ? list([]) : Response.json({ investigation: saved, accessKey: 'copy-this-once' }));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    render(<SavedInvestigations {...props()} />);
    await expand();
    await screen.findByText('No saved investigations yet.');
    name('Private');
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    await screen.findByText(/Copy this key now/);
    fireEvent.click(screen.getByRole('button', { name: 'Save as new' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Investigation access' }) as HTMLSelectElement).value).toBe('private');
  });
});

describe('saved investigation public persistence', () => {
  it('saves privately, restores research after remount, renames, forks, shares, and verifies deletion on disk', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-saved-public-'));
    const server = await createApiServer({ dataDir: root });
    servers.push({ server, root });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const base = `http://127.0.0.1:${address.port}`;
    let failSave = true;
    boundary(async (route, init) => {
      if (route === '/api/investigations' && init.method === 'POST' && failSave) {
        failSave = false;
        return Response.json({ error: 'Disk temporarily unavailable' }, { status: 503 });
      }
      return nativeFetch(base + route, init);
    });
    const onSaved = vi.fn();
    const current = props({ researchSnapshot: snapshot, onSaved });
    const first = render(<SavedInvestigations {...current} />);
    await expand();
    await screen.findByText('No saved investigations yet.');
    name('  Durable launch evidence  ');
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Disk temporarily unavailable');
    expect((await new InvestigationStore(new CanvasStore(root)).list({ workspaceId: 'acme-team' })).investigations).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    await saveFinished('Saved Durable launch evidence (private).');
    await screen.findByRole('button', { name: 'Open' });
    const saved = onSaved.mock.calls[0][0] as InvestigationRecord;
    const key = JSON.parse(window.localStorage.getItem(keysName)!)[saved.id] as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const file = path.join(root, 'investigations', saved.id + '.json');
    const durable = JSON.parse(await readFile(file, 'utf8'));
    expect(durable).toMatchObject({ messages: record.messages, researchSnapshot: snapshot, title: 'Durable launch evidence', visibility: 'private' });
    expect(await readFile(file, 'utf8')).not.toContain(key);
    expect((await nativeFetch(base + '/api/investigations/' + saved.id)).status).toBe(404);
    first.unmount();
    const { useAppState } = await import('./app-state');
    const { useResearchSession } = await import('./app-research');
    function RestoreResearch() {
      const state = useAppState();
      const research = useResearchSession(state);
      return <><SavedInvestigations {...current} onOpen={value => research.restoreResearchSnapshot(value.researchSnapshot)} /><output aria-label="Restored research">{state.researchLayout + ':' + state.answerTurns.map(turn => turn.answer).join('|')}</output></>;
    }
    render(<RestoreResearch />);
    await expand();
    await openFirst();
    expect(screen.getByLabelText('Restored research').textContent).toBe('roadmap:Beta testing remains.');
    expect(JSON.parse(window.localStorage.getItem('symbiknow:research-session') ?? 'null')).toMatchObject({ turns: snapshot.turns });
    name('Renamed launch evidence');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await saveFinished('Saved Renamed launch evidence (private).');
    expect(await new InvestigationStore(new CanvasStore(root)).get(saved.id, key)).toMatchObject({ title: 'Renamed launch evidence', revision: 2, researchSnapshot: snapshot });
    fireEvent.click(screen.getByRole('button', { name: 'Save as new' }));
    expect((screen.getByRole('textbox', { name: 'Investigation name' }) as HTMLInputElement).value).toBe('');
    name('Independent fork');
    access('shared');
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    await saveFinished('Saved Independent fork (shared).');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(2));
    const fork = onSaved.mock.calls.at(-1)![0] as InvestigationRecord;
    expect(fork.id).not.toBe(saved.id);
    expect(await new InvestigationStore(new CanvasStore(root)).get(fork.id)).toMatchObject({ revision: 1, researchSnapshot: snapshot });
    access('private');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await saveFinished('Saved Independent fork (private).');
    const forkKey = JSON.parse(window.localStorage.getItem(keysName)!)[fork.id] as string;
    expect((await nativeFetch(base + '/api/investigations/' + fork.id)).status).toBe(404);
    expect(await new InvestigationStore(new CanvasStore(root)).get(fork.id, forkKey)).toMatchObject({ revision: 2 });
    access('shared');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await saveFinished('Saved Independent fork (shared).');
    expect(JSON.parse(window.localStorage.getItem(keysName)!)).not.toHaveProperty(fork.id);
    expect((await nativeFetch(base + '/api/investigations/' + fork.id, { method: 'DELETE' })).status).toBe(200);
    await expect(readFile(path.join(root, 'investigations', fork.id + '.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(1));
    expect((await nativeFetch(base + '/api/investigations/' + saved.id, { method: 'DELETE' })).status).toBe(404);
    expect((await nativeFetch(base + '/api/investigations/' + saved.id, { method: 'DELETE', headers: { 'x-investigation-key': key } })).status).toBe(200);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('No saved investigations yet.');
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('saved investigation visible validation and recovery', () => {
  it.each([
    ['message count', { messages: Array.from({ length: 101 }, () => ({ role: 'user' as const, content: 'Valid' })) }],
    ['blank message', { messages: [{ role: 'user' as const, content: '   ' }] }],
    ['long message', { messages: [{ role: 'assistant' as const, content: 'x'.repeat(20_001) }] }],
    ['source count', { sourceRefs: Array.from({ length: 101 }, () => ({ canvasId: 'product-roadmap', blockId: 'beta' })) }],
    ['proposal count', { proposalRefs: Array.from({ length: 101 }, () => ({ kind: 'chat' as const, id: 'proposal' })) }],
    ['research bytes', { researchSnapshot: { ...snapshot, turns: [{ ...snapshot.turns[0], answer: 'é'.repeat(500_001) }] } }],
  ])('rejects an oversized or invalid %s without writing and allows a corrected retry', async (_label, invalid) => {
    const fetcher = boundary(route => route.endsWith('/list') ? list([]) : Response.json({ investigation: record }));
    const current = props();
    const view = render(<SavedInvestigations {...current} {...invalid} />);
    await expand();
    await screen.findByText('No saved investigations yet.');
    name('Valid name');
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/exceeds/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.rerender(<SavedInvestigations {...current} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    await saveFinished('Saved Launch evidence (private).');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('does not submit whitespace or a duplicate submit while a write is pending', async () => {
    const saving = held<Response>();
    const fetcher = boundary(route => route.endsWith('/list') ? list([]) : saving.promise);
    render(<SavedInvestigations {...props({ messages: [] })} />);
    await expand();
    await screen.findByText('No saved investigations yet.');
    name('   ');
    const form = screen.getByRole('textbox', { name: 'Investigation name' }).closest('form')!;
    fireEvent.submit(form);
    expect(fetcher).toHaveBeenCalledTimes(1);
    name('No question');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => saving.resolve(Response.json({ investigation: record })));
    await saveFinished('Saved Launch evidence (private).');
  });
  it.each(['malformed', 'null', 'array', 'number'])('shows %s browser key data as a list failure and retries after correction', async kind => {
    window.localStorage.setItem(keysName, { malformed: '{', null: 'null', array: '[]', number: '42' }[kind]!);
    const fetcher = boundary(() => list([]));
    render(<SavedInvestigations {...props()} />);
    await expand();
    expect((await screen.findByRole('alert')).textContent).toContain('Could not list investigations');
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByText('No saved investigations yet.')).toBeNull();
    window.localStorage.setItem(keysName, JSON.stringify({ 'valid-id': 'valid-key', 'Invalid/ID': 'ignored-key', 'numeric-key': 42 }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry list' }));
    await screen.findByText('No saved investigations yet.');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).privateKeys).toEqual(['valid-key']);
  });
  it('surfaces an unknown browser storage exception as a recoverable list error', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw 'browser failure'; });
    boundary(() => list([]));
    render(<SavedInvestigations {...props()} />);
    await expand();
    expect((await screen.findByRole('alert')).textContent).toContain('Request failed. Try again.');
    get.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Retry list' }));
    await screen.findByText('No saved investigations yet.');
  });
  it('shows open failure, retries with the restored browser key, and clears selection for a new record', async () => {
    const fetcher = boundary((route, init) => route.endsWith('/list') ? list([{ ...record, visibility: 'private' }]) : new Headers(init.headers).get('x-investigation-key') === 'correct-key' ? Response.json({ ...record, visibility: 'private' }) : Response.json({ error: 'Investigation not found' }, { status: 404 }));
    const current = props({ onClearSelection: vi.fn() });
    render(<SavedInvestigations {...current} />);
    await expand();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not open investigation');
    window.localStorage.setItem(keysName, JSON.stringify({ [record.id]: 'correct-key' }));
    await openFirst();
    expect(current.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));
    expect(fetcher).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Save as new' }));
    expect(current.onClearSelection).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Opened investigation details')).toBeNull();
  });
});

describe('saved investigation sources and proposals', () => {
  it('compares current, changed, missing and unverifiable references and opens evidence without changing the saved snapshot', async () => {
    const saved: InvestigationRecord = {
      ...record, sourceRefs: [
        { canvasId: 'product-roadmap', blockId: 'current', contentHash: 'aaaaaaaaaaaaaaaa', revisionId: 'revision-1' },
        { canvasId: 'product-roadmap', blockId: 'changed', contentHash: 'aaaaaaaaaaaaaaaa', excerpt: 'Earlier context' },
        { canvasId: 'product-roadmap', blockId: 'missing' },
        { canvasId: 'product-roadmap', blockId: 'no-saved-hash' },
        { canvasId: 'product-roadmap', blockId: 'no-current-hash', contentHash: 'aaaaaaaaaaaaaaaa' },
      ], proposalRefs: [{ kind: 'chat', id: 'proposal-1' }, { kind: 'jev', id: 'jev-1', status: 'applied' }]
    };
    const current = props({ onOpenSource: vi.fn(), onRecheck: vi.fn() });
    boundary(route => route.endsWith('/list') ? list([saved]) : route.includes('/canvases/') ? Response.json({
      id: 'product-roadmap', blocks: [
        { id: 'current', title: 'Current', content: 'Supported', contentHash: 'aaaaaaaaaaaaaaaa' },
        { id: 'changed', title: 'Changed', content: 'Updated context', contentHash: 'bbbbbbbbbbbbbbbb' },
        { id: 'no-saved-hash', title: 'Untracked', content: 'Hash absent', contentHash: 'aaaaaaaaaaaaaaaa' },
        { id: 'no-current-hash', title: 'No hash', content: 'No current hash' },
      ]
    }) : Response.json(saved));
    render(<SavedInvestigations {...current} />);
    await expand();
    await openFirst();
    await screen.findByText('2 sources changed since this investigation was saved');
    expect(screen.getByText(/2 sources cannot be compared/)).toBeTruthy();
    fireEvent.click(screen.getByText('Compare source context'));
    expect(screen.getByText('Earlier context')).toBeTruthy();
    expect(screen.getByText('Updated context')).toBeTruthy();
    expect(screen.getByText('No saved passage available.')).toBeTruthy();
    expect(screen.getByText('Document no longer available.')).toBeTruthy();
    expect(screen.getByText(/Saved hash unavailable · Current hash document missing/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recheck answer against current sources' }));
    expect(current.onRecheck).toHaveBeenCalledWith(saved, expect.arrayContaining([expect.objectContaining({ state: 'changed' }), expect.objectContaining({ state: 'missing' })]));
    fireEvent.click(screen.getByRole('button', { name: 'Open product-roadmap / current' }));
    expect(current.onOpenSource).toHaveBeenCalledWith(saved.sourceRefs[0]);
    expect(screen.getByText('Revision revision-1')).toBeTruthy();
    expect(screen.getByText('Status unknown')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review proposal in Chat' })).toBeNull();
  });
  it('describes a single untracked source and renders sources/proposals without optional handlers', async () => {
    const saved = { ...record, sourceRefs: [{ canvasId: 'product-roadmap', blockId: 'beta' }], proposalRefs: [{ kind: 'chat' as const, id: 'proposal', status: 'pending' }] };
    boundary(route => route.endsWith('/list') ? list([saved]) : route.includes('/canvases/') ? Response.json({ id: 'product-roadmap', blocks: [{ id: 'beta', content: 'Current' }] }) : Response.json(saved));
    render(<SavedInvestigations {...props()} />);
    await expand();
    await openFirst();
    await screen.findByText(/1 source cannot be compared/);
    expect(screen.getByText('product-roadmap / beta')).toBeTruthy();
    expect(screen.getByLabelText('Opened investigation details').textContent).toContain('1 proposal');
  });
  it.each([null, { id: 42, blocks: [] }, { id: 'product-roadmap', blocks: null }])('surfaces malformed current documents and recovers on reopening: %j', async invalid => {
    let valid = false;
    const saved = { ...record, sourceRefs: [{ canvasId: 'product-roadmap', blockId: 'beta', contentHash: 'aaaaaaaaaaaaaaaa' }] };
    boundary(route => route.endsWith('/list') ? list([saved]) : route.includes('/canvases/') ? Response.json(valid ? { id: 'product-roadmap', blocks: [{ id: 'beta', content: 'Supported', contentHash: 'aaaaaaaaaaaaaaaa' }] } : invalid) : Response.json(saved));
    render(<SavedInvestigations {...props()} />);
    await expand();
    await openFirst();
    await screen.findByText(/Current canvas data is unavailable/);
    valid = true;
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.queryByText(/Source freshness could not be checked/)).toBeNull());
    await waitFor(() => expect(screen.queryByText(/Checking saved sources/)).toBeNull());
    expect(screen.queryByText(/changed since/)).toBeNull();
  });
  it.each(['success', 'failure'])('ignores a stale source check %s after another record is opened', async outcome => {
    const pending = held<Response>();
    const saved = { ...record, sourceRefs: [{ canvasId: 'product-roadmap', blockId: 'beta' }] };
    const other = { ...record, id: 'saved-2', title: 'New evidence' };
    const current = props();
    boundary(route => route.endsWith('/list') ? list([saved, other]) : route.includes('/canvases/') ? pending.promise : route.endsWith('/saved-1') ? Response.json(saved) : Response.json(other));
    const view = render(<SavedInvestigations {...current} openRequest={{ id: saved.id, sequence: 1 }} />);
    await screen.findByText(/Checking saved sources/);
    view.rerender(<SavedInvestigations {...current} openRequest={{ id: other.id, sequence: 2 }} />);
    await screen.findByText('Opened New evidence. Save changes to update this investigation.');
    await act(async () => outcome === 'success' ? pending.resolve(Response.json({ id: 'product-roadmap', blocks: [] })) : pending.reject(new Error('Old source failed')));
    expect(screen.queryByText(/Source freshness could not be checked/)).toBeNull();
    expect(screen.queryByText(/changed since/)).toBeNull();
  });
  it('shows a proposal failure and allows retry to a successful review', async () => {
    const saved = { ...record, proposalRefs: [{ kind: 'chat' as const, id: 'proposal-1' }] };
    const onOpenProposal = vi.fn().mockRejectedValueOnce('expired').mockResolvedValue(undefined);
    boundary(route => route.endsWith('/list') ? list([saved]) : Response.json(saved));
    render(<SavedInvestigations {...props({ onOpenProposal })} />);
    await expand();
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Review proposal in Chat' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not open proposal: Request failed. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Review proposal in Chat' }));
    await screen.findByText('Opened proposal proposal-1 in Chat.');
    expect(onOpenProposal).toHaveBeenCalledWith(saved.proposalRefs[0], saved);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('saved investigation request cancellation and key recovery', () => {
  it.each(['success', 'failure'])('does not populate an obsolete list on a late %s', async outcome => {
    const pending = held<Response>();
    let requests = 0;
    boundary(() => ++requests === 1 ? pending.promise : list([]));
    const current = props();
    const view = render(<SavedInvestigations {...current} />);
    await expand();
    await screen.findByText('Loading investigations…');
    view.rerender(<SavedInvestigations {...current} workspaceId="other-team" />);
    await screen.findByText('No saved investigations yet.');
    await act(async () => outcome === 'success' ? pending.resolve(list()) : pending.reject(new Error('Old list failed')));
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Loading investigations…')).toBeNull();
  });
  it.each(['success', 'failure'])('does not invoke open callbacks after unmount on %s', async outcome => {
    const pending = held<Response>();
    const current = props();
    boundary(route => route.endsWith('/list') ? list() : pending.promise);
    const view = render(<StrictMode><SavedInvestigations {...current} /></StrictMode>);
    await expand();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    view.unmount();
    await act(async () => outcome === 'success' ? pending.resolve(Response.json(record)) : pending.reject(new Error('Old open failed')));
    expect(current.onOpen).not.toHaveBeenCalled();
  });
  it.each(['success', 'failure'])('ignores late proposal %s after changing workspace', async outcome => {
    const pending = held<void>();
    const saved = { ...record, proposalRefs: [{ kind: 'chat' as const, id: 'proposal' }] };
    const current = props({ onOpenProposal: () => pending.promise });
    boundary(route => route.endsWith('/list') ? list([saved]) : Response.json(saved));
    const view = render(<SavedInvestigations {...current} />);
    await expand();
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Review proposal in Chat' }));
    view.rerender(<SavedInvestigations {...current} workspaceId="other-team" />);
    await act(async () => outcome === 'success' ? pending.resolve() : pending.reject(new Error('Old proposal failed')));
    expect(screen.queryByText(/Opened proposal/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('retains a completed private save key after navigation, even though it cannot restore the prior workspace', async () => {
    const pending = held<Response>();
    const current = props({ onSaved: vi.fn() });
    boundary(route => route.endsWith('/list') ? list([]) : pending.promise);
    const view = render(<SavedInvestigations {...current} />);
    await expand();
    await screen.findByText('No saved investigations yet.');
    name('Pending private');
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    view.rerender(<SavedInvestigations {...current} workspaceId="other-team" />);
    await act(async () => pending.resolve(Response.json({ investigation: { ...record, visibility: 'private' }, accessKey: 'late-private-key' })));
    expect(JSON.parse(window.localStorage.getItem(keysName)!)).toEqual({ [record.id]: 'late-private-key' });
    expect(current.onSaved).not.toHaveBeenCalled();
  });
  it('reports a failed key cleanup after a successful shared save and leaves the saved record usable', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    boundary(route => route.endsWith('/list') ? list([]) : Response.json({ investigation: record }));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    render(<SavedInvestigations {...props()} />);
    await expand();
    await screen.findByText('No saved investigations yet.');
    name('Shared');
    access('shared');
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    await saveFinished('Saved Launch evidence (shared).');
    expect(log).toHaveBeenCalledWith('Could not remove the obsolete investigation access key.', expect.any(Error));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('reports an inaccessible private save key after navigation when browser storage is blocked', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pending = held<Response>();
    const current = props();
    boundary(route => route.endsWith('/list') ? list([]) : pending.promise);
    const view = render(<SavedInvestigations {...current} />);
    await expand();
    await screen.findByText('No saved investigations yet.');
    name('Private');
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    view.unmount();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    await act(async () => pending.resolve(Response.json({ investigation: record, accessKey: 'late-key' })));
    expect(log).toHaveBeenCalledWith('Could not retain the completed investigation access key after navigation.');
  });
  it('ignores a save failure from the workspace that was left', async () => {
    const pending = held<Response>();
    const current = props();
    boundary(route => route.endsWith('/list') ? list([]) : pending.promise);
    const view = render(<SavedInvestigations {...current} />);
    await expand();
    await screen.findByText('No saved investigations yet.');
    name('Earlier save');
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    view.rerender(<SavedInvestigations {...current} workspaceId="other-team" />);
    await act(async () => pending.reject(new Error('Old save failed')));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('saved investigation domain safeguards', () => {
  it('invalidates a held open even when navigation returns to the original workspace', async () => {
    const pending = held<Response>();
    const current = props();
    boundary(route => route.endsWith('/list') ? list() : pending.promise);
    const view = render(<SavedInvestigations {...current} />);
    await expand();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    view.rerender(<SavedInvestigations {...current} workspaceId="other-team" />);
    view.rerender(<SavedInvestigations {...current} />);
    await act(async () => pending.resolve(Response.json(record)));
    expect(current.onOpen).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Opened investigation details')).toBeNull();
  });
});

// The public model also rejects review attempts when no proposal handler was provided.
it('keeps the public proposal action idle when the optional review handler is absent', async () => {
  const fetcher = boundary(() => list([]));
  const { result } = renderHook(() => useSavedInvestigations(props()));
  await act(async () => result.current.openProposal({ kind: 'chat', id: 'unavailable' }, record));
  expect(result.current.busy).toBe(false);
  expect(result.current.error).toBe('');
  expect(fetcher).not.toHaveBeenCalled();
});
