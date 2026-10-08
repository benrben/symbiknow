// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIElementsChat } from './AIElementsChat';
import { api } from './api';
import type { AIElementsChatProps, DisplayTurn } from './chat-types';
import type { ChatProposal, ChatProposalReceipt } from './chatStream';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { InvestigationRecord } from './SavedInvestigations';

const before: CanvasBlock = { id: 'qa', title: 'QA report', content: 'Before QA', contentHash: '1111111111111111', file: 'qa.md', kind: 'markdown', x: 0, y: 0, width: 300, height: 200, links: [] };
const after = { ...before, content: 'After QA', contentHash: '2222222222222222' };
const canvas: CanvasDocument = { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [before] };
const change = { id: 'edit-qa', blockId: 'qa', type: 'edit' as const, title: before.title, before, after, expectedContentHash: before.contentHash! };
const proposal: ChatProposal = { id: 'proposal', canvasId: canvas.id, status: 'pending', changes: [change] };
const receipt: ChatProposalReceipt = { id: proposal.id, status: 'applied', applied: [change.id], skipped: [], createdBlockIds: {}, documents: [{ id: change.id, before, after }] };
const saved: InvestigationRecord = { id: 'saved', workspaceId: 'team', title: 'QA investigation', visibility: 'shared', canvasId: 'planning', messages: [{ role: 'user', content: 'Review QA' }, { role: 'assistant', content: 'Earlier QA answer' }], sourceRefs: [], proposalRefs: [{ kind: 'chat', id: 'proposal' }], revision: 1, createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z' };
function props(overrides: Partial<AIElementsChatProps> = {}): AIElementsChatProps {
  return { canvasId: 'planning', canvas: null, viewContext: { selectedBlockIds: [] }, answerTurns: [], hasApiKey: true, model: 'test-model', onOpenSettings: vi.fn(),
    onCanvasChanged: vi.fn(async () => ({ created: [], updated: [] })), onShowBlock: vi.fn(), onNavigate: vi.fn(), onReturnNavigation: vi.fn(), onUndoCreatedBlock: vi.fn(), onUndoEditedBlock: vi.fn(),
    onCanvasSources: vi.fn(), onCanvasPatch: vi.fn(), onCanvasAnswer: vi.fn(), onCanvasTurnEnd: vi.fn(), onOpenAnswerCanvas: vi.fn(), ...overrides };
}
function stream(text = 'Prepared QA changes', staged = proposal) { return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\nevent: chat_proposal\ndata: ${JSON.stringify(staged)}\n\ndata: [DONE]\n\n`); }
function send(text: string) { fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: text } }); fireEvent.click(screen.getByRole('button', { name: 'Submit' })); }
function chatRequests() {
  return vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === '/api/chat/stream' && init?.method === 'POST');
}
function expectRetryRead() {
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/canvases/planning')).toHaveLength(1);
  expect(fetch).toHaveBeenCalledWith('/api/canvases/planning', expect.objectContaining({ cache: 'no-store' }));
}
function history(turns: Partial<DisplayTurn>[]) { window.localStorage.setItem('symbiknow:chat-history', JSON.stringify(turns.map((turn, index) => ({ id: index + 1, role: 'assistant', content: 'Cached proposal', activities: [], ...turn })))); }
async function openSaved() { const heading = screen.getByText('Saved investigations'); if (!heading.closest('details')?.open) fireEvent.click(heading); fireEvent.click(await screen.findByRole('button', { name: 'Open' })); await screen.findByRole('button', { name: 'Review proposal in Chat' }); }
function savedFetch(record: InvestigationRecord, result: ChatProposal | ChatProposalReceipt) {
  return async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/investigations/list') return Response.json({ investigations: [{ ...record, messageCount: record.messages.length, sourceCount: record.sourceRefs.length, proposalCount: record.proposalRefs.length }] });
    if (path === '/api/investigations/saved') return Response.json(record);
    if (path === '/api/chat/proposals/proposal') return Response.json(result);
    if (path === '/api/canvases/planning') return Response.json(canvas);
    if (path === '/api/chat/stream') return new Response('data: {"choices":[{"delta":{"content":"Current QA answer"}}]}\n\ndata: [DONE]\n\n');
    throw new Error('Unexpected request ' + path);
  };
}
beforeEach(() => {
  window.localStorage.clear(); window.sessionStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('proposal recovery and receipts', () => {
  it('removes recovered selections that the current saved proposal no longer allows', async () => {
    history([{ proposal, proposalState: 'pending', selectedProposalIds: [change.id] }]);
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...proposal, changes: [{ ...change, canApply: false }] }));
    render(<AIElementsChat {...props()}/>);
    await screen.findByText('This change cannot be applied from Chat. Use the document controls to make it.');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Apply selected (0)' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('recovers a pending proposal with default selections when older history did not store them', async () => {
    history([{ proposal, proposalState: 'pending' }]); vi.mocked(fetch).mockResolvedValue(Response.json(proposal)); render(<AIElementsChat {...props()}/>);
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true));
    expect((screen.getByRole('button', { name: 'Apply selected (1)' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('applies only the checked changes and retains saved/undo receipts when refreshing the canvas fails', async () => {
    const secondChange = { ...change, id: 'edit-other', blockId: 'other', title: 'Other note' };
    const blocked = { ...change, id: 'blocked', blockId: 'blocked', title: 'Locked note', canApply: false };
    const staged = { ...proposal, changes: [change, secondChange, blocked] }; let persisted = before; let didWrite = false; const writes: unknown[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === '/api/chat/stream') return stream('Review these updates', staged);
      if (path === '/api/canvases/planning') return Response.json({ ...canvas, blocks: [persisted] });
      if (path.endsWith('/apply')) { writes.push(JSON.parse(String(init?.body))); persisted = after; didWrite = true; return Response.json(receipt); }
      if (path.endsWith('/undo')) { persisted = before; return Response.json({ id: proposal.id, status: 'reverted', reverted: [change.id], skipped: [] }); }
      throw new Error(path);
    });
    const onCanvasChanged = vi.fn(async () => { await api('/canvases/planning'); if (didWrite) throw new Error('Refresh unavailable'); return { created: [], updated: [] }; });
    render(<AIElementsChat {...props({ onCanvasChanged })}/>); send('Update QA'); const region = await screen.findByRole('region', { name: 'Review proposed document changes' });
    fireEvent.click(within(region).getByRole('checkbox', { name: /Other note/ }));
    fireEvent.click(within(region).getByRole('checkbox', { name: /QA report/ })); expect((within(region).getByRole('button', { name: 'Apply selected (0)' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(region).getByRole('checkbox', { name: /QA report/ })); fireEvent.click(within(region).getByRole('button', { name: 'Apply selected (1)' }));
    expect((await within(region).findByRole('alert')).textContent).toContain('Changes saved, but the canvas could not refresh'); expect(writes).toEqual([{ changeIds: [change.id] }]);
    expect((await api<CanvasDocument>('/canvases/planning')).blocks[0].content).toBe(after.content);
    expect(within(region).queryByRole('button', { name: /Apply selected/ })).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Undo applied changes' }));
    await waitFor(() => expect(within(region).getByRole('alert').textContent).toContain('Undo saved, but the canvas could not refresh'));
    expect((await api<CanvasDocument>('/canvases/planning')).blocks[0].content).toBe(before.content);
    expect(within(region).queryByRole('button', { name: 'Undo applied changes' })).toBeNull();
  });

  it.each(['apply', 'undo'] as const)('keeps a failed %s retry available and expires it when the server withdraws the proposal', async action => {
    history([{ role: 'user', content: 'Retain my question' }, { proposal, proposalState: action === 'undo' ? 'applied' : 'pending', selectedProposalIds: [change.id], ...(action === 'undo' ? { proposalReceipt: receipt } : {}) }]);
    let attempts = 0;
    vi.mocked(fetch).mockImplementation(async input => {
      const path = String(input); if (path === '/api/chat/proposals/proposal') return Response.json(action === 'undo' ? receipt : proposal);
      if (path === '/api/canvases/planning') return Response.json(canvas);
      if (path.endsWith('/' + action)) return Response.json({ error: ++attempts === 1 ? 'Please retry this request' : 'This proposal is no longer available' }, { status: 409 });
      throw new Error(path);
    });
    render(<AIElementsChat {...props()}/>); const name = action === 'undo' ? 'Undo applied changes' : 'Apply selected (1)';
    const button = await screen.findByRole('button', { name }); fireEvent.click(button); expect((await screen.findByRole('alert')).textContent).toBe('Please retry this request');
    fireEvent.click(await screen.findByRole('button', { name })); await screen.findByRole('heading', { name: 'Proposal expired' }); expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('shows no changes saved when the server skips every selected change', async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const path = String(input); if (path === '/api/chat/stream') return stream(); if (path === '/api/canvases/planning') return Response.json(canvas);
      return Response.json({ ...receipt, applied: [], skipped: [{ id: change.id, reason: 'Document changed' }] });
    });
    render(<AIElementsChat {...props()}/>); send('Stage a change'); fireEvent.click(await screen.findByRole('button', { name: 'Apply selected (1)' }));
    await screen.findByRole('heading', { name: 'No changes saved' }); expect(screen.queryByRole('button', { name: 'Undo applied changes' })).toBeNull();
    expect(screen.getByText(/Document changed/)).toBeTruthy();
  });

  it('keeps partially reverted changes available for another Undo', async () => {
    history([{ proposal, proposalState: 'applied', proposalReceipt: receipt }]);
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/undo') ? Response.json({ id: proposal.id, status: 'partial', reverted: [], skipped: [{ id: change.id, reason: 'Newer edit' }] }) : Response.json(String(input).includes('/canvases/') ? canvas : receipt));
    render(<AIElementsChat {...props()}/>); fireEvent.click(await screen.findByRole('button', { name: 'Undo applied changes' }));
    await screen.findByRole('button', { name: 'Retry Undo for remaining changes' }); expect(screen.getByText(/Newer edit/)).toBeTruthy();
  });

  it('marks a restored unavailable proposal expired and never rehydrates expired or reverted history', async () => {
    history([{ proposal, proposalState: 'pending' }, { proposal: { ...proposal, id: 'expired' }, proposalState: 'expired' }, { proposal: { ...proposal, id: 'reverted' }, proposalState: 'reverted' }]);
    vi.mocked(fetch).mockRejectedValue(new Error('Unavailable')); render(<AIElementsChat {...props()}/>);
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Proposal expired' })).toHaveLength(2)); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('recovers saved proposal receipts including edit/create/delete document changes (applied=%s)', async applied => {
    const documents = [receipt.documents![0], { id: 'created', before: null, after: { ...after, title: 'Created note' } }, { id: 'deleted', before: { ...before, title: 'Deleted note' }, after: null }, { id: 'unavailable', before: null, after: null }];
    vi.mocked(fetch).mockImplementation(savedFetch({ ...saved, canvasId: undefined }, { ...receipt, applied: applied ? receipt.applied : [], documents }));
    render(<AIElementsChat {...props({ canvas })}/>); await openSaved(); fireEvent.click(screen.getByRole('button', { name: 'Review proposal in Chat' }));
    const region = await screen.findByRole('region', { name: 'Review proposed document changes' }); expect(within(region).getByText('create · Created note')).toBeTruthy(); expect(within(region).getByText('delete · Deleted note')).toBeTruthy(); expect(within(region).getByText('create · unavailable')).toBeTruthy();
    expect(within(region).queryByRole('button', { name: /Apply selected/ })).toBeNull(); expect(within(region).getByRole('heading', { name: applied ? 'Changes applied' : 'No changes saved' })).toBeTruthy();
  });
});

describe('saved investigation sources and recheck', () => {
  it('saves unique usable cited sources, research and proposals, then clears the active selection for a new investigation', async () => {
    const source = { canvasId: 'planning', canvasName: 'Planning', blockId: 'qa', title: 'QA report', contentHash: before.contentHash, excerpt: 'Q'.repeat(2_100), relevance: 1 };
    let payload: Record<string, unknown> | undefined;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input); if (path === '/api/chat/stream') return new Response(`event: answer_canvas\ndata: ${JSON.stringify({ canvasId: 'planning', query: 'QA', selection: 'local', sources: [source, source, { ...source, blockId: '' }, { ...source, blockId: 'other', contentHash: 'invalid', excerpt: '' }] })}\n\nevent: chat_proposal\ndata: ${JSON.stringify(proposal)}\n\ndata: [DONE]\n\n`);
      if (path === '/api/investigations/list') return Response.json({ investigations: [] });
      if (path === '/api/investigations') { payload = JSON.parse(String(init?.body)); return Response.json({ investigation: { ...saved, title: 'Saved QA' } }); }
      if (path === '/api/canvases/planning') return Response.json(canvas); throw new Error(path);
    });
    const onActiveInvestigationChange = vi.fn();
    render(<AIElementsChat {...props({ canvas, onActiveInvestigationChange, answerTurns: [{ id: 1, query: 'QA', answer: 'Old answer', status: 'complete', sources: [source] }], researchEdits: { added: [], changed: {}, deleted: [], addedEdges: [], deletedEdges: [] }, researchLayout: 'roadmap' })}/>);
    send('Find QA'); await screen.findByRole('region', { name: 'Review proposed document changes' }); fireEvent.click(screen.getByText('Saved investigations'));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Investigation name' }), { target: { value: 'Saved QA' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Investigation access' }), { target: { value: 'shared' } }); fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    await screen.findByText('Saved Saved QA (shared).'); expect(payload?.sourceRefs).toEqual([{ canvasId: 'planning', blockId: 'qa', contentHash: before.contentHash, excerpt: source.excerpt.slice(0, 2_000) }, { canvasId: 'planning', blockId: 'other' }]);
    expect(payload?.proposalRefs).toEqual([{ kind: 'chat', id: proposal.id, status: 'pending' }]); expect(payload?.researchSnapshot).toMatchObject({ layout: 'roadmap' });
    expect(onActiveInvestigationChange).toHaveBeenCalledWith({ id: 'saved', canvasId: 'planning' }); fireEvent.click(screen.getByRole('button', { name: 'Save as new' })); expect(onActiveInvestigationChange).toHaveBeenLastCalledWith(undefined);
  });

  it('rechecks changed and missing sources with the saved answer and current hashes', async () => {
    const record = { ...saved, sourceRefs: [{ canvasId: 'planning', blockId: 'qa', contentHash: 'old' }, { canvasId: 'planning', blockId: 'gone' }] };
    vi.mocked(fetch).mockImplementation(savedFetch(record, proposal)); render(<AIElementsChat {...props({ canvas })}/>); await openSaved();
    fireEvent.click(await screen.findByRole('button', { name: 'Recheck answer against current sources' })); await screen.findByText('Current QA answer');
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === '/api/chat/stream'); const prompt = JSON.parse(String(call?.[1]?.body)).messages.at(-1).content;
    expect(prompt).toContain('Earlier QA answer'); expect(prompt).toContain('planning/qa: saved hash old, current hash ' + before.contentHash); expect(prompt).toContain('planning/gone: saved hash unknown, current hash missing'); expect(prompt).toContain('Do not edit documents');
  });

  it('restores the previous conversation/research and lets the user return from a saved source or dismiss the return notice', async () => {
    const record = { ...saved, sourceRefs: [{ canvasId: 'planning', blockId: 'qa', excerpt: 'Before QA' }], researchSnapshot: { turns: [], edits: { added: [], changed: {}, deleted: [], addedEdges: [], deletedEdges: [] }, layout: 'roadmap' as const } };
    vi.mocked(fetch).mockImplementation(savedFetch(record, proposal));
    const onRestoreResearch = vi.fn(); const onReturnNavigation = vi.fn(); const onNavigate = vi.fn();
    const research = [{ id: 4, query: 'Current research', answer: 'Original research', sources: [], status: 'complete' as const }];
    render(<AIElementsChat {...props({ canvas, answerTurns: research, researchEdits: record.researchSnapshot.edits, researchLayout: 'roadmap', onRestoreResearch, onReturnNavigation, onNavigate })}/>);
    await openSaved(); fireEvent.click(screen.getByRole('button', { name: 'Open planning / qa' })); expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ title: 'QA report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back' })); expect(onReturnNavigation).toHaveBeenCalledOnce(); expect(screen.queryByText('Opened a saved source.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore previous conversation and canvas' })); expect(onRestoreResearch).toHaveBeenLastCalledWith({ turns: research, edits: record.researchSnapshot.edits, layout: 'roadmap' });
    await openSaved(); fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); expect(screen.queryByRole('button', { name: 'Restore previous conversation and canvas' })).toBeNull();
  });
});

describe('chat browser persistence and recovery', () => {
  it('keeps usable messages and the current draft when browser storage cannot be read or written', async () => {
    const getItem = Storage.prototype.getItem; const setItem = Storage.prototype.setItem;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) { if (this === window.sessionStorage) throw new Error('Storage denied'); return getItem.call(this, key); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) { if (key.startsWith('symbiknow:chat-')) throw new Error('Storage full'); setItem.call(this, key, value); });
    vi.mocked(fetch).mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"In-memory reply"}}]}\n\ndata: [DONE]\n\n'));
    render(<AIElementsChat {...props()}/>); const input = screen.getByRole('textbox', { name: 'Message Symbi' }); expect((input as HTMLTextAreaElement).value).toBe('');
    send('In-memory question'); await screen.findByText('In-memory reply'); fireEvent.change(input, { target: { value: 'Unsaved follow-up' } });
    await waitFor(() => expect(warning).toHaveBeenCalledWith('Chat history cannot be saved; the current conversation remains available in memory.'));
    fireEvent(window, new Event('pagehide')); expect(warning).toHaveBeenCalledWith('Chat history could not be saved before leaving the page.');
    expect(warning).toHaveBeenCalledWith('The chat draft cannot be saved; it remains available until this page closes.'); expect((input as HTMLTextAreaElement).value).toBe('Unsaved follow-up'); expect(screen.getByText('In-memory reply')).toBeTruthy();
  });

  it('focuses the requested current document context and falls back safely when a selected scope disappears', async () => {
    const current = props({ canvas, viewContext: { selectedBlockIds: ['qa'], editingBlockId: 'qa' } });
    const view = render(<div className="chat-panel"><AIElementsChat {...current}/></div>);
    expect(screen.getByRole('textbox', { name: 'Message Symbi' }).getAttribute('placeholder')).toBe('Ask Symbi to review or edit this document…');
    fireEvent.click(screen.getByRole('button', { name: 'Choose assistant context' })); fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Assistant context options' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose assistant context' })); fireEvent.click(screen.getByRole('button', { name: /Selected documents/ }));
    expect(screen.getByRole('button', { name: 'Choose assistant context' }).textContent).toContain('1 selected');
    view.rerender(<div className="chat-panel"><AIElementsChat {...current} focusRequest={1}/></div>); expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message Symbi' }));
    expect(screen.getByRole('button', { name: 'Choose assistant context' }).textContent).toContain('QA report');
    fireEvent.click(screen.getByRole('button', { name: 'Choose assistant context' })); fireEvent.click(screen.getByRole('button', { name: /Selected documents/ }));
    view.rerender(<div className="chat-panel"><AIElementsChat {...current} viewContext={{ selectedBlockIds: [] }} focusRequest={1}/></div>);
    expect(screen.getByRole('button', { name: 'Choose assistant context' }).textContent).toContain('Planning');
    const starter = within(screen.getByRole('group', { name: 'Suggested questions' })).getAllByRole('button')[0]; vi.mocked(fetch).mockResolvedValue(new Response('data: [DONE]\n\n'));
    fireEvent.click(starter); await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    fireEvent.click(within(await screen.findByRole('group', { name: 'Suggested follow-up questions' })).getAllByRole('button')[0]); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it('queues several prompts while Settings is open and only requests Settings once', async () => {
    const current = props({ hasApiKey: false }); const view = render(<AIElementsChat {...current} promptRequest={{ text: 'One', sequence: 1 }}/>);
    view.rerender(<AIElementsChat {...current} promptRequest={{ text: 'Two', sequence: 2 }}/>); expect(current.onOpenSettings).toHaveBeenCalledOnce();
    vi.mocked(fetch).mockImplementation(async () => new Response('data: [DONE]\n\n'));
    view.rerender(<AIElementsChat {...current} hasApiKey promptRequest={{ text: 'Two', sequence: 2 }}/>); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); expect(screen.getByText('One')).toBeTruthy(); expect(screen.getByText('Two')).toBeTruthy();
  });

  it('retries reconnect checks without overlap, preserves a later draft, and reports a restored connection', async () => {
    let tick!: () => void; const interval = window.setInterval.bind(window); vi.spyOn(window, 'setInterval').mockImplementation((callback, delay, ...args) => { if (delay === 4000) { tick = callback as () => void; return 999 as unknown as ReturnType<typeof window.setInterval>; } return interval(callback, delay, ...args) as unknown as ReturnType<typeof window.setInterval>; });
    const clear = vi.spyOn(window, 'clearInterval'); const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let rejectChat!: (reason: unknown) => void; const reply = new Promise<Response>((_resolve, reject) => { rejectChat = reject; });
    let resolveProbe!: (response: Response) => void; const probe = new Promise<Response>(resolve => { resolveProbe = resolve; });
    let chatAttempts = 0; let probes = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const route = String(input);
      if (route === '/api/canvases/planning' && !init?.method) return Response.json(canvas);
      if (route === '/api/chat/stream' && init?.method === 'POST') return chatAttempts++ === 0 ? reply
        : new Response('data: {"choices":[{"delta":{"content":"Recovered reply"}}]}\n\ndata: [DONE]\n\n');
      if (route !== '/api/workspaces' || init?.method) throw new Error('Unexpected reconnect request ' + route);
      if (probes++ === 0) return probe;
      if (probes === 2) throw new Error('Not yet');
      return Response.json([]);
    });
    render(<AIElementsChat {...props()}/>); send('Original question'); fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Later draft' } });
    await act(async () => rejectChat(new Error('Offline'))); await screen.findByText('Checking the connection. Your question is still here.');
    expect((screen.getByRole('textbox', { name: 'Message Symbi' }) as HTMLTextAreaElement).value).toBe('Later draft');
    await act(async () => { tick(); tick(); }); expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => resolveProbe(new Response('', { status: 503 }))); await act(async () => tick()); expect(warning).toHaveBeenCalledWith('Canvas reconnect check failed; the visible error remains and the check will retry.');
    await act(async () => tick()); await screen.findByText('Connection restored. Your question is ready to retry.'); expect(clear).toHaveBeenCalledWith(999);
    fireEvent.click(screen.getByRole('button', { name: 'Retry answer' })); await screen.findByText('Recovered reply'); expect(screen.queryByRole('alert')).toBeNull();
    expectRetryRead(); expect(chatRequests()).toHaveLength(2);
    expect(chatRequests()[1][1]?.body).toBe(chatRequests()[0][1]?.body);
    expect(screen.getAllByText('Original question')).toHaveLength(1);
    const request = JSON.parse(String(chatRequests()[1][1]?.body)); expect(request.messages).toEqual([{ role: 'user', content: 'Original question' }]);
  });

  it('ignores a reconnect reply and future timer callbacks after the chat unmounts', async () => {
    let tick!: () => void; const interval = window.setInterval.bind(window); vi.spyOn(window, 'setInterval').mockImplementation((callback, delay, ...args) => { if (delay === 4000) { tick = callback as () => void; return 998 as unknown as ReturnType<typeof window.setInterval>; } return interval(callback, delay, ...args) as unknown as ReturnType<typeof window.setInterval>; });
    let resolve!: (response: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Offline')).mockReturnValueOnce(pending); const view = render(<AIElementsChat {...props()}/>); send('Reconnect later');
    await screen.findByText('Checking the connection. Your question is still here.'); await act(async () => tick()); view.unmount(); await act(async () => { resolve(Response.json([])); tick(); }); expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('chat recovery races and older saved records', () => {
  it('saves legacy pending proposal metadata and binds an unscoped saved record to the current canvas', async () => {
    history([{ role: 'user', content: 'Earlier question' }, { proposal }]);
    let resolveProposal!: (reply: Response) => void; const held = new Promise<Response>(resolve => { resolveProposal = resolve; });
    let payload: Record<string, unknown> | undefined;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === '/api/chat/proposals/proposal') return held;
      if (path === '/api/investigations/list') return Response.json({ investigations: [] });
      if (path === '/api/investigations') { payload = JSON.parse(String(init?.body)); return Response.json({ investigation: { ...saved, canvasId: undefined } }); }
      throw new Error(path);
    });
    const onActiveInvestigationChange = vi.fn(); render(<AIElementsChat {...props({ canvas, onActiveInvestigationChange })}/>);
    fireEvent.click(screen.getByText('Saved investigations')); fireEvent.change(await screen.findByRole('textbox', { name: 'Investigation name' }), { target: { value: 'Legacy investigation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' })); await screen.findByText('Saved QA investigation (private).');
    expect(payload?.proposalRefs).toEqual([{ kind: 'chat', id: proposal.id, status: 'pending' }]); expect(onActiveInvestigationChange).toHaveBeenCalledWith({ id: 'saved', canvasId: 'planning' });
    await act(async () => resolveProposal(Response.json(proposal))); expect(screen.getByText('Earlier question')).toBeTruthy();
  });

  it('opens an unscoped investigation, rechecks sources without a previous answer, and recovers a receipt with no documents', async () => {
    const record = { ...saved, canvasId: undefined, messages: [{ role: 'user' as const, content: 'Where is the missing source?' }], sourceRefs: [{ canvasId: 'planning', blockId: 'gone' }] };
    vi.mocked(fetch).mockImplementation(savedFetch(record, { ...receipt, documents: undefined, applied: [] })); const onActiveInvestigationChange = vi.fn();
    render(<AIElementsChat {...props({ canvas, onActiveInvestigationChange })}/>); await openSaved(); expect(onActiveInvestigationChange).toHaveBeenCalledWith({ id: 'saved', canvasId: 'planning' });
    fireEvent.click(screen.getByRole('button', { name: 'Review proposal in Chat' })); await screen.findByRole('heading', { name: 'No changes saved' });
    fireEvent.click(screen.getByRole('button', { name: 'Recheck answer against current sources' })); await screen.findByText('Current QA answer');
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === '/api/chat/stream'); expect(JSON.parse(String(call?.[1]?.body)).messages.at(-1).content).toContain('Earlier answer:\n\n\nChanged sources:');
  });

  it('rehydrates an all-skipped receipt without touching unrelated messages', async () => {
    history([{ role: 'user', content: 'Retain this question' }, { proposal, proposalState: 'pending' }]);
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...receipt, applied: [] })); render(<AIElementsChat {...props()}/>);
    await screen.findByRole('heading', { name: 'No changes saved' }); expect(screen.getByText('Retain this question')).toBeTruthy();
  });

  it.each(['success', 'failure'] as const)('ignores late proposal rehydration %s after unmount', async result => {
    history([{ proposal, proposalState: 'pending', selectedProposalIds: [change.id] }]);
    let resolve!: (reply: Response) => void; let reject!: (reason: unknown) => void; const held = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
    vi.mocked(fetch).mockReturnValue(held); const view = render(<AIElementsChat {...props()}/>); const stored = window.localStorage.getItem('symbiknow:chat-history'); view.unmount();
    await act(async () => { if (result === 'success') resolve(Response.json(receipt)); else reject(new Error('Gone')); });
    expect(window.localStorage.getItem('symbiknow:chat-history')).toBe(stored); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['created', 'edited'] as const)('keeps failed legacy %s undo available and blocks concurrent undo of another document', async kind => {
    const other = { ...before, id: 'other', title: 'Other QA' };
    history([{ role: 'user', content: 'Keep the original question' }, { createdCanvasId: canvas.id, ...(kind === 'created' ? { createdBlocks: [before, other] } : { editedBlocks: [{ before, after }, { before: other, after: { ...other, content: 'After other QA' } }] }) }]);
    let reject!: (reason: unknown) => void; const undo = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    render(<AIElementsChat {...props(kind === 'created' ? { onUndoCreatedBlock: undo } : { onUndoEditedBlock: undo })}/>);
    if (kind === 'edited') { fireEvent.click(screen.getByText('Review changes to QA report')); fireEvent.click(screen.getByText('Review changes to Other QA')); }
    const name = kind === 'created' ? 'Undo creation' : 'Undo edit'; const buttons = screen.getAllByRole('button', { name }); fireEvent.click(buttons[0]); fireEvent.click(buttons[1]); expect(undo).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('The document was updated elsewhere'))); await screen.findByText('The document was updated elsewhere'); expect(screen.getByText('Keep the original question')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name })[0]); expect(undo).toHaveBeenCalledTimes(2); await act(async () => reject(new Error('Still updated elsewhere'))); await screen.findByText('Still updated elsewhere');
  });

  it('ignores a completed run’s held canvas refresh after opening another investigation', async () => {
    let finishRefresh!: (changes: { created: CanvasBlock[]; updated: [] }) => void; const refresh = new Promise<{ created: CanvasBlock[]; updated: [] }>(resolve => { finishRefresh = resolve; });
    const onCanvasChanged = vi.fn(() => refresh); const current = props({ canvas, onCanvasChanged }); const clear = vi.spyOn(globalThis, 'clearTimeout');
    vi.mocked(fetch).mockImplementation(savedFetch(saved, proposal)); const view = render(<AIElementsChat {...current}/>); send('Finish the old conversation'); await screen.findByText('Current QA answer');
    await waitFor(() => expect(onCanvasChanged).toHaveBeenCalledOnce()); view.rerender(<AIElementsChat {...current} investigationOpenRequest={{ id: 'saved', sequence: 1 }}/>);
    await screen.findByText('Earlier QA answer'); expect(clear).toHaveBeenCalled(); await act(async () => finishRefresh({ created: [{ ...after, title: 'Stale creation' }], updated: [] }));
    expect(screen.queryByText('Stale creation')).toBeNull(); expect(screen.queryByText('Current QA answer')).toBeNull(); expect(screen.getByText('Earlier QA answer')).toBeTruthy();
  });
});


it('keeps a rejected no-canvas question for Retry and sends it once a canvas becomes available', async () => {
  history([{ role: 'user', content: 'Keep my earlier question' }]);
  vi.mocked(fetch).mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"Recovered no-canvas question"}}]}\n\ndata: [DONE]\n\n'));
  const current = props({ canvasId: '' }); const view = render(<AIElementsChat {...current}/>); send('The question awaiting a canvas');
  await screen.findByText('Open a canvas before using the assistant.'); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(fetch).not.toHaveBeenCalled(); expect(screen.getByText('Keep my earlier question')).toBeTruthy();
  view.rerender(<AIElementsChat {...current} canvasId="planning"/>); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('Recovered no-canvas question');
  const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)); expect(request.canvasId).toBe('planning');
  expect(request.messages).toEqual([{ role: 'user', content: 'Keep my earlier question' }, { role: 'user', content: 'The question awaiting a canvas' }]);
});


it('returns the completion indicator to idle after the completion window', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"Complete answer"}}]}\n\ndata: [DONE]\n\n'));
  const onAvatarStateChange = vi.fn(); render(<AIElementsChat {...props({ onAvatarStateChange })}/>); send('Finish my answer'); await screen.findByText('Complete answer');
  await waitFor(() => expect(onAvatarStateChange).toHaveBeenLastCalledWith('done'));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 930)); }); expect(onAvatarStateChange).toHaveBeenLastCalledWith('idle');
});

it('pauses retry of a failed answer while its canvas is unavailable and preserves the original question', async () => {
  let attempts = 0;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input) === '/api/canvases/planning' && !init?.method) return Response.json(canvas);
    if (String(input) !== '/api/chat/stream' || init?.method !== 'POST') throw new Error('Unexpected retry request ' + String(input));
    return attempts++ === 0 ? Response.json({ error: 'Failed answer' }, { status: 409 })
      : new Response('data: {"choices":[{"delta":{"content":"Retried answer"}}]}\n\ndata: [DONE]\n\n');
  });
  const current = props(); const view = render(<AIElementsChat {...current}/>); send('Original retry question'); await screen.findByText('Failed answer');
  view.rerender(<AIElementsChat {...current} canvasId=""/>); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('Open a canvas before using the assistant.'); expect(fetch).toHaveBeenCalledTimes(1);
  view.rerender(<AIElementsChat {...current}/>); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('Retried answer');
  expectRetryRead(); expect(chatRequests()).toHaveLength(2);
  expect(chatRequests()[1][1]?.body).toBe(chatRequests()[0][1]?.body);
  expect(screen.getAllByText('Original retry question')).toHaveLength(1);
  expect(JSON.parse(String(chatRequests()[1][1]?.body)).messages).toEqual([{ role: 'user', content: 'Original retry question' }]);
});
