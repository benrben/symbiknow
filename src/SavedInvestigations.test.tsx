// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from './api';
import { SavedInvestigations, type InvestigationRecord } from './SavedInvestigations';

vi.mock('./api', () => ({ api: vi.fn() }));
const mockedApi = vi.mocked(api);
const record: InvestigationRecord = { id: 'investigation-1', workspaceId: 'acme-team', canvasId: 'roadmap',
  title: 'Launch questions', visibility: 'private', question: 'What blocks launch?',
  messages: [{ role: 'user', content: 'What blocks launch?' }], sourceRefs: [{ canvasId: 'roadmap', blockId: 'checklist' }],
  proposalRefs: [{ kind: 'chat', id: 'proposal-1', status: 'pending' }], revision: 1,
  createdAt: '2026-09-28T10:00:00Z', updatedAt: '2026-09-28T10:00:00Z' };
const summary = { id: record.id, workspaceId: record.workspaceId, canvasId: record.canvasId, title: record.title,
  visibility: record.visibility, question: record.question, revision: record.revision,
  createdAt: record.createdAt, updatedAt: record.updatedAt, messageCount: 1, sourceCount: 1, proposalCount: 1 };
const props = { workspaceId: 'acme-team', canvasId: 'roadmap', messages: record.messages,
  sourceRefs: record.sourceRefs, proposalRefs: record.proposalRefs, onOpen: vi.fn() };

afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe('SavedInvestigations', () => {
  it('waits until opened to list and refreshes an open list when the workspace changes', async () => {
    mockedApi.mockResolvedValue({ investigations: [] } as never);
    const { rerender } = render(<SavedInvestigations {...props}/>);
    expect(mockedApi).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('No saved investigations yet.')).toBeNull();

    rerender(<SavedInvestigations {...props} workspaceId="other-team"/>);
    expect(mockedApi).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Saved investigations/));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/investigations/list',
      expect.objectContaining({ body: expect.stringContaining('other-team') })));
    await screen.findByText('No saved investigations yet.');

    rerender(<SavedInvestigations {...props} workspaceId="third-team"/>);
    await waitFor(() => expect(mockedApi).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(mockedApi.mock.calls[1][1]?.body)).workspaceId).toBe('third-team');
  });

  it('saves a private investigation, reopens it with its browser key, and updates by revision', async () => {
    let saved = false;
    mockedApi.mockImplementation((path) => {
      if (path === '/investigations/list') return Promise.resolve({ investigations: saved ? [summary] : [] }) as ReturnType<typeof api>;
      if (path === '/investigations') { saved = true; return Promise.resolve({ investigation: record, accessKey: 'private-access-key' }) as ReturnType<typeof api>; }
      if (path === '/investigations/investigation-1') return Promise.resolve(record) as ReturnType<typeof api>;
      return Promise.reject(new Error('Unexpected request'));
    });
    const onOpenSource = vi.fn();
    const onOpenProposal = vi.fn().mockResolvedValue(undefined);
    render(<SavedInvestigations {...props} onOpenSource={onOpenSource} onOpenProposal={onOpenProposal}/>);
    fireEvent.click(screen.getByText(/Saved investigations/));
    expect(await screen.findByText('No saved investigations yet.')).toBeTruthy();
    expect(screen.getByText(/Private access is saved in this browser/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Investigation name' }), { target: { value: 'Launch questions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved Launch questions'));
    expect(window.localStorage.getItem('symbiknow.investigation-keys.v1')).toContain('private-access-key');
    expect(await screen.findByRole('button', { name: 'Open' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(props.onOpen).toHaveBeenCalledWith(record));
    expect(screen.getByLabelText('Opened investigation details').textContent).toContain('proposal-1');
    fireEvent.click(screen.getByRole('button', { name: 'Open roadmap / checklist' }));
    expect(onOpenSource).toHaveBeenCalledWith(record.sourceRefs[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Review proposal in Chat' }));
    await waitFor(() => expect(onOpenProposal).toHaveBeenCalledWith(record.proposalRefs[0], record));
    const getCall = mockedApi.mock.calls.find(([path, init]) => path === '/investigations/investigation-1' && !init?.method);
    expect((getCall?.[1]?.headers as Record<string, string>)['x-investigation-key']).toBe('private-access-key');
    mockedApi.mockImplementation((path) => path === '/investigations/list'
      ? Promise.resolve({ investigations: [{ ...summary, title: 'Updated', revision: 2 }] }) as ReturnType<typeof api>
      : Promise.resolve({ investigation: { ...record, title: 'Updated', revision: 2 } }) as ReturnType<typeof api>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Investigation name' }), { target: { value: 'Updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText('Saved Updated (private).')).toBeTruthy());
    const patch = mockedApi.mock.calls.find(([path, init]) => path === '/investigations/investigation-1' && init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ expectedRevision: 1, title: 'Updated', messages: record.messages,
      sourceRefs: record.sourceRefs, proposalRefs: record.proposalRefs });
  });

  it('shows a list error and retries without presenting an empty collection', async () => {
    let attempts = 0;
    mockedApi.mockImplementation(() => ++attempts === 1 ? Promise.reject(new Error('Server unavailable'))
      : Promise.resolve({ investigations: [summary] }) as ReturnType<typeof api>);
    render(<SavedInvestigations {...props}/>);
    fireEvent.click(screen.getByText(/Saved investigations/));
    expect((await screen.findByRole('alert')).textContent).toContain('Server unavailable');
    expect(screen.queryByText('No saved investigations yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry list' }));
    expect(await screen.findByRole('button', { name: 'Open' })).toBeTruthy();
  });

  it('exposes a private key for copying if browser storage refuses it', async () => {
    mockedApi.mockImplementation(path => path === '/investigations/list'
      ? Promise.resolve({ investigations: [] }) as ReturnType<typeof api>
      : Promise.resolve({ investigation: record, accessKey: 'one-time-private-key' }) as ReturnType<typeof api>);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    render(<SavedInvestigations {...props}/>);
    fireEvent.click(screen.getByText(/Saved investigations/));
    await screen.findByText('No saved investigations yet.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Investigation name' }), { target: { value: 'Launch questions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Copy this key now: one-time-private-key');
  });

  it('saves and reopens a named investigation with the full research snapshot', async () => {
    const researchSnapshot = { turns: [{ id: 1, query: 'What changed?', answer: 'QA shifted.', sources: [], status: 'complete' as const }],
      edits: { added: [], changed: {}, deleted: [], addedEdges: [], deletedEdges: [] }, layout: 'roadmap' as const };
    const saved = { ...record, researchSnapshot };
    mockedApi.mockImplementation(path => {
      if (path === '/investigations/list') return Promise.resolve({ investigations: [summary] }) as ReturnType<typeof api>;
      if (path === '/investigations') return Promise.resolve({ investigation: saved, accessKey: 'private-key' }) as ReturnType<typeof api>;
      if (path === '/investigations/investigation-1') return Promise.resolve(saved) as ReturnType<typeof api>;
      throw new Error('Unexpected request');
    });
    const onOpen = vi.fn();
    render(<SavedInvestigations {...props} onOpen={onOpen} researchSnapshot={researchSnapshot}/>);
    fireEvent.click(screen.getByText(/Saved investigations/));
    await screen.findByRole('button', { name: 'Open' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Investigation name' }), { target: { value: 'Research' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save investigation' }));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/investigations', expect.objectContaining({ method: 'POST' })));
    const post = mockedApi.mock.calls.find(([path]) => path === '/investigations');
    expect(JSON.parse(String(post?.[1]?.body)).researchSnapshot).toEqual(researchSnapshot);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(saved));
    expect(screen.getByLabelText('Opened investigation details').textContent).toContain('1 research turns');
  });

  it('marks a saved answer stale and compares source context before one-click recheck', async () => {
    const stale = { ...record, sourceRefs: [{ canvasId: 'roadmap', blockId: 'checklist',
      contentHash: 'aaaaaaaaaaaaaaaa', excerpt: 'Saved: launch in April.' }] };
    mockedApi.mockImplementation(path => {
      if (path === '/investigations/list') return Promise.resolve({ investigations: [summary] }) as ReturnType<typeof api>;
      if (path === '/investigations/investigation-1') return Promise.resolve(stale) as ReturnType<typeof api>;
      if (path === '/canvases/roadmap') return Promise.resolve({ id: 'roadmap', blocks: [{ id: 'checklist', title: 'Checklist',
        content: 'Current: launch in May.', contentHash: 'bbbbbbbbbbbbbbbb' }] }) as ReturnType<typeof api>;
      throw new Error('Unexpected request');
    });
    const onRecheck = vi.fn();
    render(<SavedInvestigations {...props} onRecheck={onRecheck}/>);
    fireEvent.click(screen.getByText(/Saved investigations/));
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/source changed since this investigation was saved/)).toBeTruthy();
    fireEvent.click(screen.getByText('Compare source context'));
    expect(screen.getByText('Saved: launch in April.')).toBeTruthy();
    expect(screen.getByText('Current: launch in May.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recheck answer against current sources' }));
    expect(onRecheck).toHaveBeenCalledWith(stale, [expect.objectContaining({ blockId: 'checklist',
      oldHash: 'aaaaaaaaaaaaaaaa', currentHash: 'bbbbbbbbbbbbbbbb', state: 'changed' })]);
  });

  it('opens a task-linked investigation and reveals its details without another click', async () => {
    mockedApi.mockImplementation(path => path === '/investigations/list'
      ? Promise.resolve({ investigations: [summary] }) as ReturnType<typeof api>
      : path === '/investigations/investigation-1'
        ? Promise.resolve(record) as ReturnType<typeof api>
        : Promise.reject(new Error('Current source unavailable')));
    const onOpen = vi.fn();
    render(<SavedInvestigations {...props} onOpen={onOpen} openRequest={{ id: record.id, sequence: 1 }}/>);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(record));
    expect(screen.getByLabelText('Opened investigation details')).toBeTruthy();
    expect(screen.getByText(/Saved investigations/).closest('details')?.open).toBe(true);
  });
});
