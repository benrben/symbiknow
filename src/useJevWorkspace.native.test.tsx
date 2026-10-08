// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useJevWorkspace } from './useJevWorkspace';
import { ownerWorkspaceView, workspaceFailure } from './jev-workspace-status';
import type { JevViewState } from './jev-client-types';
import { api } from './api';
import { workspaceFixture, closeWorkspaceFixtures } from './native-workspace.test.fixture';
import { JevWorkspaceFiles } from '../server/jev/workspace';
import { sourceSnapshot } from '../server/jev/stamps';
import { acceptanceReflexProvider } from '../features/acceptance-reflex-provider';
import type { JevMutation, JevSourceSnapshot, JevWorkspaceState } from '../shared/jev-types';

beforeEach(() => { vi.stubEnv('TYPESAFE_API_KEY', ''); });
afterEach(async () => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); await closeWorkspaceFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function saveReceipt(state: JevWorkspaceState, id: string, mutation: JevMutation, sources: JevSourceSnapshot[], before = mutation) {
  const now = new Date().toISOString();
  state.proposals.push({ id: `${id}-proposal`, jobId: `${id}-job`, action: 'profile', state: 'applied', createdAt: now,
    title: id, explanation: 'Saved source-backed result.', sources, evidence: [], mutation });
  state.receipts.push({ id, proposalId: `${id}-proposal`, action: 'profile', automatic: true, state: 'applied',
    createdAt: now, actor: 'automation', before, after: mutation, sourcesAfter: sources });
}

it('saves initial settings before the first read finishes and ignores the older response during that save', async () => {
  const fixture = await workspaceFixture();
  const firstRead = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  const save = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/settings`, 'PUT');
  const hook = renderHook(() => useJevWorkspace(fixture.workspace.id));
  await firstRead.response;
  let saving!: Promise<unknown>;
  act(() => { saving = hook.result.current.send('settings', { paused: true }, 'PUT'); });
  expect((await save.response).ok).toBe(true);
  await act(async () => { await firstRead.release(); });
  expect(hook.result.current.state).toBeNull(); expect(hook.result.current.busy).toBe(true);
  await act(async () => { await save.release(); await saving; });
  expect(hook.result.current.state?.settings.paused).toBe(true); expect(hook.result.current.avatar).toBe('paused');
  expect(hook.result.current.notice).toBe('Workspace settings updated.');
  expect((await new JevWorkspaceFiles(fixture.root).read(fixture.workspace.id)).settings.paused).toBe(true);
});

it('keeps the current workspace when an older workspace read completes or fails after navigation', async () => {
  const fixture = await workspaceFixture(); const files = new JevWorkspaceFiles(fixture.root);
  const other = await files.read(fixture.secondWorkspace.id); other.settings.people = [{ id: 'ada', name: 'Ada', role: 'Engineer' }];
  await files.write(fixture.secondWorkspace.id, other);
  const stale = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  const hook = renderHook(({ workspaceId }) => useJevWorkspace(workspaceId), { initialProps: { workspaceId: fixture.workspace.id } });
  await stale.response; const oldRefresh = hook.result.current.refresh;
  hook.rerender({ workspaceId: fixture.secondWorkspace.id });
  await waitFor(() => expect(hook.result.current.state?.settings.people[0]?.name).toBe('Ada'));
  await act(async () => { await stale.release(); });
  expect(hook.result.current.state?.settings.people[0]?.name).toBe('Ada');
  const beforeRetry = fixture.calls.length;
  await act(async () => { await oldRefresh(); });
  expect(fixture.calls).toHaveLength(beforeRetry);
  const failure = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  hook.rerender({ workspaceId: fixture.workspace.id }); await failure.response;
  hook.rerender({ workspaceId: fixture.secondWorkspace.id });
  await waitFor(() => expect(hook.result.current.state?.settings.people[0]?.name).toBe('Ada'));
  await act(async () => { failure.fail('The previous workspace is unavailable'); });
  expect(hook.result.current.error).toBe(''); expect(hook.result.current.state?.settings.people[0]?.name).toBe('Ada');
});

it('refreshes saved canvas metadata after automatic receipt changes and tolerates a reader without a refresh callback', async () => {
  const fixture = await workspaceFixture(); const files = new JevWorkspaceFiles(fixture.root);
  let labels: string[] = []; const changed = vi.fn(async () => { labels = (await fixture.reload()).blocks[0].tags ?? []; });
  const hook = renderHook(() => useJevWorkspace(fixture.workspace.id, true, changed));
  await waitFor(() => expect(hook.result.current.state).not.toBeNull());
  await fixture.store.updateBlock(fixture.canvas.id, fixture.canvas.blocks[0].id, { tags: ['Release'] }, 'Symbi Reflex');
  const canvas = await fixture.reload(); const source = sourceSnapshot(fixture.workspace.id, canvas.id, canvas.blocks[0]);
  const state = await files.read(fixture.workspace.id);
  state.receipts.push({ id: 'automatic-label', proposalId: 'saved-label', action: 'label', automatic: true, actor: 'automation', createdAt: new Date().toISOString(), state: 'applied',
    before: { kind: 'document', canvasId: canvas.id, blockId: source.blockId, patch: { tags: [] } },
    after: { kind: 'document', canvasId: canvas.id, blockId: source.blockId, patch: { tags: ['Release'] } }, sourcesAfter: [source] });
  state.proposals.push({ id: 'saved-label', jobId: 'automatic-label-job', action: 'label', title: 'Release label', explanation: 'Saved release classification.',
    state: 'applied', createdAt: new Date().toISOString(), sources: [source], evidence: [], mutation: state.receipts[0].after });
  await files.write(fixture.workspace.id, state);
  await waitFor(() => expect(changed).toHaveBeenCalledOnce(), { timeout: 2200 });
  // Invocation precedes the native canvas read; observe its completion before checking the saved labels.
  await act(async () => { await changed.mock.results[0].value; });
  expect(labels).toEqual(['Release']); expect(hook.result.current.state?.receipts[0]?.id).toBe('automatic-label');
  hook.unmount();
  const reader = renderHook(() => useJevWorkspace(fixture.workspace.id));
  await waitFor(() => expect(reader.result.current.state?.receipts).toHaveLength(1));
  state.receipts[0].state = 'undone'; await files.write(fixture.workspace.id, state);
  await act(async () => { await reader.result.current.refresh(); });
  expect(reader.result.current.state?.receipts[0]?.state).toBe('undone'); expect(reader.result.current.error).toBe('');
});

it('reports a non-Error canvas refresh failure after the workspace reset was saved', async () => {
  const fixture = await workspaceFixture({ fetcher: acceptanceReflexProvider });
  await api<JevViewState>(`/workspaces/${fixture.workspace.id}/jev/state`);
  await fixture.store.deleteWorkspace('acme-team');
  for (const block of fixture.canvas.blocks) await fixture.store.deleteBlock(fixture.canvas.id, block.id);
  await api('/settings', { method: 'PUT', body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: 'native-reset-refresh-key' } }) });
  const changed = async () => { throw 'Canvas reload was interrupted'; };
  const hook = renderHook(() => useJevWorkspace(fixture.workspace.id, true, changed));
  await waitFor(() => expect(hook.result.current.state).not.toBeNull());
  await act(async () => { await hook.result.current.send('reset'); });
  expect(hook.result.current.error).toBe('The change could not be saved');
  expect(hook.result.current.busy).toBe(false);
  expect((await new JevWorkspaceFiles(fixture.root).read(fixture.workspace.id)).profiles).toEqual({});
  expect(fixture.calls.some(call => call.route === `/api/workspaces/${fixture.workspace.id}/jev/reset` && call.method === 'POST')).toBe(true);
  expect(workspaceFailure('Interrupted refresh', 'Retry loading the canvas')).toBe('Retry loading the canvas');
});

it('rejects a scoped agent read as an owner view and requires complete owner-state metadata', async () => {
  const fixture = await workspaceFixture();
  const credential = await fixture.store.createMcpToken('Read saved activity', 'read', { allowedCanvasIds: [fixture.canvas.id], tools: ['jev_activity'] });
  const owner = await api<JevViewState>(`/workspaces/${fixture.workspace.id}/jev/state`);
  await expect(api<JevViewState>(`/workspaces/${fixture.workspace.id}/jev/state`, { headers: { authorization: `Bearer ${credential.token}` } }))
    .rejects.toThrow('This caller does not permit that canonical API operation');
  const scoped = await api<JevViewState>(`/canvases/${fixture.canvas.id}/jev/agent/state?view=jev_activity`, { headers: { authorization: `Bearer ${credential.token}` } });
  const message = 'Open Symbi Reflex with an authenticated workspace owner session.';
  expect(ownerWorkspaceView(owner)).toEqual(owner);
  expect(() => ownerWorkspaceView(scoped)).toThrow(message);
  expect(() => ownerWorkspaceView({ ...owner, hasApiKey: undefined } as unknown as JevViewState)).toThrow(message);
  expect(() => ownerWorkspaceView(null as unknown as JevViewState)).toThrow(message);
  expect(() => ownerWorkspaceView({ settings: {} } as JevViewState)).toThrow(message);
});

it('keeps an unchanged workspace snapshot and avoids a canvas reload for a threshold save', async () => {
  const fixture = await workspaceFixture(); const changed = vi.fn(async () => undefined);
  const hook = renderHook(() => useJevWorkspace(fixture.workspace.id, true, changed));
  await waitFor(() => expect(hook.result.current.state).not.toBeNull());
  const previous = hook.result.current.state;
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.state).toBe(previous);
  await act(async () => { await hook.result.current.send('settings', { confidenceThresholds: { profile: 0.85 } }, 'PUT'); });
  expect(hook.result.current.state?.settings.confidenceThresholds?.profile).toBe(0.85);
  expect(changed).not.toHaveBeenCalled();
});

it('coalesces concurrent workspace refreshes until the current native read finishes', async () => {
  const fixture = await workspaceFixture();
  const hook = renderHook(() => useJevWorkspace(fixture.workspace.id));
  await waitFor(() => expect(hook.result.current.state).not.toBeNull());
  const held = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  const before = fixture.calls.length;
  let first!: Promise<void>; let second!: Promise<void>;
  act(() => { first = hook.result.current.refresh(); }); await held.response;
  act(() => { second = hook.result.current.refresh(); });
  expect(fixture.calls.slice(before).filter(call => call.route.includes('/jev/state'))).toHaveLength(1);
  await act(async () => { await held.release(); await Promise.all([first, second]); });
  expect(hook.result.current.error).toBe('');
});

it('loads full saved evidence only while details are open and skips derived, task and remote canvas reloads', async () => {
  const fixture = await workspaceFixture(); const files = new JevWorkspaceFiles(fixture.root);
  const remote = await fixture.store.createCanvas(fixture.workspace.id, { name: 'Remote references' });
  const remoteBlock = await fixture.store.createBlock(remote.id, { title: 'Remote guide', content: '# Remote evidence' });
  const source = sourceSnapshot(fixture.workspace.id, fixture.canvas.id, fixture.canvas.blocks[0]);
  const other = sourceSnapshot(fixture.workspace.id, remote.id, remoteBlock);
  const changed = vi.fn(async () => undefined);
  const hook = renderHook(() => useJevWorkspace(fixture.workspace.id, true, changed, fixture.canvas.id));
  await waitFor(() => expect(hook.result.current.state).not.toBeNull());
  const state = await files.read(fixture.workspace.id);
  state.profiles[`${fixture.canvas.id}:${source.blockId}`] = { role: 'instructions', keyPassages: ['Read the deployment checklist.'],
    qualityRubric: { specificity: { score: 3, confidence: 0.95 } } };
  saveReceipt(state, 'derived-quality', { kind: 'derived', blockId: source.blockId, values: { qualityRubric: { specificity: 3 } } }, [source]);
  saveReceipt(state, 'task-responsibility', { kind: 'task_update', canvasId: fixture.canvas.id, taskId: 'native-task',
    expectedUpdatedAt: '2020-01-01T00:00:00Z', patch: { assignee: 'Ada' } }, [source]);
  saveReceipt(state, 'remote-label', { kind: 'document', canvasId: remote.id, blockId: remoteBlock.id, patch: { tags: ['Remote'] } }, [other]);
  await files.write(fixture.workspace.id, state);
  await act(async () => { await hook.result.current.refresh(); });
  expect(changed).not.toHaveBeenCalled();
  expect(hook.result.current.state?.proposals).toEqual([]);
  expect(hook.result.current.state?.profiles[`${fixture.canvas.id}:${source.blockId}`].qualityRubric).toBeUndefined();
  const compact = hook.result.current.state;
  act(() => hook.result.current.setDetailsOpen(true));
  await waitFor(() => expect(hook.result.current.state?.proposals).toHaveLength(3));
  expect(hook.result.current.state?.profiles[`${fixture.canvas.id}:${source.blockId}`].qualityRubric).toEqual({ specificity: { score: 3, confidence: 0.95 } });
  expect(hook.result.current.state).not.toBe(compact); expect(changed).not.toHaveBeenCalled();
  const full = hook.result.current.state; const before = fixture.calls.length;
  act(() => hook.result.current.setDetailsOpen(true));
  expect(fixture.calls).toHaveLength(before);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.state).toBe(full);
  expect(fixture.calls.filter(call => call.route.endsWith('/jev/state'))).toHaveLength(1);
  const updated = await files.read(fixture.workspace.id);
  updated.profiles[`${fixture.canvas.id}:${source.blockId}`].qualityRubric = { specificity: { score: 4, confidence: 0.96 } };
  await files.write(fixture.workspace.id, updated);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.state?.profiles[`${fixture.canvas.id}:${source.blockId}`].qualityRubric).toEqual({ specificity: { score: 4, confidence: 0.96 } });
  expect(hook.result.current.state).not.toBe(full);
  await act(async () => { await hook.result.current.send('settings', { confidenceThresholds: { profile: 0.85 } }, 'PUT'); });
  expect(hook.result.current.state?.settings.confidenceThresholds?.profile).toBe(0.85);
  expect(hook.result.current.state?.profiles[`${fixture.canvas.id}:${source.blockId}`].qualityRubric).toEqual({ specificity: { score: 4, confidence: 0.96 } });
  act(() => hook.result.current.setDetailsOpen(false));
  await waitFor(() => expect(hook.result.current.state?.proposals).toEqual([]));
  expect(fixture.calls.filter(call => call.route.endsWith('/jev/state'))).toHaveLength(3);
  expect(fixture.calls.filter(call => call.route.endsWith('/jev/state?summary=1')).length).toBeGreaterThanOrEqual(4);
  expect(changed).not.toHaveBeenCalled();
});

it('refreshes local metadata, content, both sides of a move, vocabulary and Undo without refreshing another canvas', async () => {
  const fixture = await workspaceFixture(); const files = new JevWorkspaceFiles(fixture.root);
  const remote = await fixture.store.createCanvas(fixture.workspace.id, { name: 'Delivery' });
  const block = await fixture.store.createBlock(remote.id, { title: 'Delivery guide', content: '# Delivery' });
  const source = sourceSnapshot(fixture.workspace.id, fixture.canvas.id, fixture.canvas.blocks[0]);
  const other = sourceSnapshot(fixture.workspace.id, remote.id, block);
  const changed = vi.fn(async () => undefined);
  const hook = renderHook(({ canvasId }) => useJevWorkspace(fixture.workspace.id, true, changed, canvasId), { initialProps: { canvasId: fixture.canvas.id } });
  await waitFor(() => expect(hook.result.current.state).not.toBeNull());
  const mutations: JevMutation[] = [
    { kind: 'document', canvasId: fixture.canvas.id, blockId: source.blockId, patch: { tags: ['Release'] } },
    { kind: 'content', canvasId: fixture.canvas.id, blockId: source.blockId, content: '# Reviewed release guide', expectedContentHash: source.contentHash, draftId: 'native-draft' },
    { kind: 'move', canvasId: fixture.canvas.id, blockId: source.blockId, targetCanvasId: remote.id },
    { kind: 'vocabulary', operation: 'rename', term: { id: 'release-term', kind: 'group', name: 'Release guides', definition: 'Guides used for a release.',
      aliases: [], state: 'active', version: 1, members: [{ canvasId: fixture.canvas.id, blockId: source.blockId }] } },
  ];
  for (const [index, mutation] of mutations.entries()) {
    const state = await files.read(fixture.workspace.id);
    saveReceipt(state, `local-result-${index}`, mutation, mutation.kind === 'move' ? [other] : [source]);
    await files.write(fixture.workspace.id, state);
    await act(async () => { await hook.result.current.refresh(); });
    expect(changed).toHaveBeenCalledTimes(index + 1);
  }
  const undone = await files.read(fixture.workspace.id); undone.receipts[0].state = 'undone'; await files.write(fixture.workspace.id, undone);
  await act(async () => { await hook.result.current.refresh(); }); expect(changed).toHaveBeenCalledTimes(5);
  hook.rerender({ canvasId: remote.id });
  await act(async () => { await hook.result.current.refresh(); }); expect(changed).toHaveBeenCalledTimes(5);
  const incoming = await files.read(fixture.workspace.id);
  saveReceipt(incoming, 'incoming-move', { kind: 'move', canvasId: fixture.canvas.id, blockId: source.blockId, targetCanvasId: remote.id }, [other]);
  await files.write(fixture.workspace.id, incoming);
  await act(async () => { await hook.result.current.refresh(); }); expect(changed).toHaveBeenCalledTimes(6);
});

it('ignores a pre-save poll that finishes later and updates provider availability without a workspace revision change', async () => {
  const fixture = await workspaceFixture();
  const hook = renderHook(() => useJevWorkspace(fixture.workspace.id));
  await waitFor(() => expect(hook.result.current.state).not.toBeNull());
  const stale = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  let reading!: Promise<void>; act(() => { reading = hook.result.current.refresh(); }); await stale.response;
  await act(async () => { await hook.result.current.send('settings', { paused: true }, 'PUT'); });
  const saved = hook.result.current.state;
  await act(async () => { await stale.release(); await reading; });
  expect(hook.result.current.state).toBe(saved); expect(hook.result.current.state?.settings.paused).toBe(true);
  await api('/settings', { method: 'PUT', body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: 'native-provider-status-key' } }) });
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.state?.revision).toBe(saved?.revision);
  expect(hook.result.current.state?.hasApiKey).toBe(true); expect(hook.result.current.state).not.toBe(saved);
  const connected = hook.result.current.state;
  await act(async () => { await hook.result.current.refresh(); }); expect(hook.result.current.state).toBe(connected);
});

it('exposes a failed native read and recovers without replacing an unchanged snapshot', async () => {
  const fixture = await workspaceFixture(); const hook = renderHook(() => useJevWorkspace(fixture.workspace.id));
  await waitFor(() => expect(hook.result.current.state).not.toBeNull()); const previous = hook.result.current.state;
  const failure = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  let reading!: Promise<void>; act(() => { reading = hook.result.current.refresh(); }); await failure.response;
  await act(async () => { failure.fail('Workspace polling temporarily unavailable'); await reading; });
  expect(hook.result.current.error).toBe('Workspace polling temporarily unavailable'); expect(hook.result.current.avatar).toBe('unavailable');
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.state).toBe(previous); expect(hook.result.current.error).toBe(''); expect(hook.result.current.avatar).toBe('resting');
});

it('makes no reads for an inactive pane or absent workspace and cancels polling when the pane closes', async () => {
  const fixture = await workspaceFixture();
  const hook = renderHook(({ workspaceId, active }) => useJevWorkspace(workspaceId, active), { initialProps: { workspaceId: fixture.workspace.id, active: false } });
  await act(async () => { await Promise.resolve(); }); expect(fixture.calls).toEqual([]);
  hook.rerender({ workspaceId: '', active: true });
  await act(async () => { await Promise.resolve(); }); expect(fixture.calls).toEqual([]);
  hook.rerender({ workspaceId: fixture.workspace.id, active: true });
  await waitFor(() => expect(hook.result.current.state).not.toBeNull());
  hook.rerender({ workspaceId: fixture.workspace.id, active: false }); const count = fixture.calls.length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)); }); expect(fixture.calls).toHaveLength(count);
  expect(hook.result.current.state).toBeNull(); expect(hook.result.current.avatar).toBe('resting');
});

it('ignores a held receipt update after the polling pane unmounts', async () => {
  const fixture = await workspaceFixture(); const files = new JevWorkspaceFiles(fixture.root); const changed = vi.fn(async () => undefined);
  const hook = renderHook(() => useJevWorkspace(fixture.workspace.id, true, changed, fixture.canvas.id));
  await waitFor(() => expect(hook.result.current.state).not.toBeNull()); const previous = hook.result.current.state;
  const state = await files.read(fixture.workspace.id);
  const source = sourceSnapshot(fixture.workspace.id, fixture.canvas.id, fixture.canvas.blocks[0]);
  saveReceipt(state, 'held-label', { kind: 'document', canvasId: fixture.canvas.id, blockId: source.blockId, patch: { tags: ['Release'] } }, [source]);
  await files.write(fixture.workspace.id, state);
  const held = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  let reading!: Promise<void>; act(() => { reading = hook.result.current.refresh(); }); await held.response;
  hook.unmount(); await act(async () => { await held.release(); await reading; });
  expect(changed).not.toHaveBeenCalled(); expect(hook.result.current.state).toBe(previous);
});

it('stops automatic state reads while the page is hidden and refreshes current canvas metadata on return', async () => {
  const fixture = await workspaceFixture(); const files = new JevWorkspaceFiles(fixture.root);
  const changed = vi.fn(async () => undefined);
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const hook = renderHook(() => useJevWorkspace(fixture.workspace.id, true, changed, fixture.canvas.id));
  await waitFor(() => expect(hook.result.current.state).not.toBeNull());
  const before = fixture.calls.length;
  visibility = 'hidden';
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)); });
  expect(fixture.calls).toHaveLength(before);
  const source = sourceSnapshot(fixture.workspace.id, fixture.canvas.id, fixture.canvas.blocks[0]);
  const state = await files.read(fixture.workspace.id);
  saveReceipt(state, 'background-label', { kind: 'document', canvasId: fixture.canvas.id, blockId: source.blockId, patch: { tags: ['Release'] } }, [source]);
  await files.write(fixture.workspace.id, state);
  visibility = 'visible';
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(hook.result.current.state?.receipts[0]?.id).toBe('background-label');
  hook.unmount(); const after = fixture.calls.length;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(fixture.calls).toHaveLength(after);
});

it('shows organizing for active retained grouping work and done for a recent saved automatic result', async () => {
  const fixture = await workspaceFixture(); const files = new JevWorkspaceFiles(fixture.root);
  const state = await files.read(fixture.workspace.id); const now = new Date().toISOString();
  state.jobs.push({ id: 'automatic-group', request: { action: 'file', canvasId: fixture.canvas.id }, state: 'running', sources: [], createdAt: now, updatedAt: now, proposalIds: [] });
  await files.write(fixture.workspace.id, state);
  const hook = renderHook(() => useJevWorkspace(fixture.workspace.id));
  await waitFor(() => expect(hook.result.current.avatar).toBe('organizing'));
  state.jobs[0].state = 'queued'; await files.write(fixture.workspace.id, state);
  await act(async () => { await hook.result.current.refresh(); }); expect(hook.result.current.avatar).toBe('thinking');
  state.jobs[0].state = 'completed'; await files.write(fixture.workspace.id, state);
  await act(async () => { await hook.result.current.refresh(); }); expect(hook.result.current.avatar).toBe('done');
  const completed = hook.result.current.state;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now) + 6000);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.state).toBe(completed); expect(hook.result.current.avatar).toBe('resting');
  clock.mockRestore();
  state.jobs[0].updatedAt = '2020-01-01T00:00:00Z'; await files.write(fixture.workspace.id, state);
  await act(async () => { await hook.result.current.refresh(); }); expect(hook.result.current.avatar).toBe('resting');
});
