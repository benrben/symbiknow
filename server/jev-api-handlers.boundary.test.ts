import { expect, it, vi } from 'vitest';
import type { CanvasBlock } from '../shared/types.js';
import type { JevPrincipal } from '../shared/jev-types.js';
import type { RouteContext } from './api-context.js';
import { ApiError } from './errors.js';
import { jevApiEndpoint, type JevApiCall } from './jev-api-handlers.js';
import type { JevRuntime } from './jev/runtime.js';
import type { DocumentJob } from './jev/runtime-document.js';
import { emptyJevWorkspace } from './jev/workspace.js';
import type { CanvasStore } from './storage.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
const workspaceId = 'offline-workspace';
const canvasId = 'sources';
const hash = 'a'.repeat(16);

function root(id: string, blockId: string, updatedAt: string, contentHash = hash, canvas = canvasId): DocumentJob {
  const source = { workspaceId, canvasId: canvas, blockId, incarnation: blockId,
    sourceGeneration: 1, metadataRevision: 1, contentHash };
  return { id, request: { action: 'profile', canvasId: canvas, blockIds: [blockId] }, state: 'completed',
    createdAt: updatedAt, updatedAt, sources: [source], proposalIds: [], principal: owner,
    authorizationFingerprint: 'offline', settingsKey: 'offline', attempts: 1,
    documentPlan: { version: 2, originalSources: [source], completedActions: ['profile', 'label', 'link',
      'flag_duplicate', 'file', 'suggest_home_canvas'], claimPreparedAt: updatedAt,
      completionPreparedAt: updatedAt, queueWaitMs: 0 } };
}

function fixture() {
  const block: CanvasBlock = { id: 'document', title: 'Offline document', file: 'docs/document.md', kind: 'markdown',
    content: '# Offline document', contentHash: hash, x: 0, y: 0, width: 320, height: 200, links: [] };
  const state = emptyJevWorkspace();
  const listWorkspaces = vi.fn(async () => [{ id: workspaceId, canvases: [{ id: canvasId }, { id: 'restricted' }] }]);
  const getCanvasSummary = vi.fn(async (id: string): Promise<{ id: string; workspaceId: string;
    blocks: Array<{ id: string; contentVersion?: string }> }> => ({ id, workspaceId,
    blocks: id === canvasId ? [{ id: block.id, contentVersion: 'v1' }] : [] }));
  const getCanvasBlock = vi.fn(async (_canvas: string, id: string) => {
    if (id !== block.id) throw new ApiError(404, 'Document not found');
    return block;
  });
  const store = { listWorkspaces, getCanvasSummary, getCanvasBlock } as unknown as CanvasStore;
  const read = vi.fn(async () => state);
  const recheckDocument = vi.fn(async () => ({ jobId: 'queued-offline' }));
  const runtime = { read, recheckDocument } as unknown as JevRuntime;
  async function call(operation: string, method = 'GET', query = '', changes: Partial<JevApiCall> = {}) {
    const context = { store, method, url: new URL(`http://localhost/jev/${operation}${query}`) } as RouteContext;
    return jevApiEndpoint(operation, method).handle({ context, workspaceId, principal: owner,
      canvasId: undefined, runtime, id: block.id, command: '', input: {}, ...changes });
  }
  return { block, state, store, runtime, listWorkspaces, getCanvasSummary, getCanvasBlock,
    read, recheckDocument, call };
}

it('guards per-document review, approval, and recheck at the exact scope and hash', async () => {
  const native = fixture();
  await expect(native.call('documents/document/review')).rejects.toMatchObject({ status: 400 });
  expect(await native.call('documents/document/review', 'GET', `?canvasId=${canvasId}`)).toMatchObject({
    blockId: native.block.id, contentHash: hash, actions: expect.arrayContaining([{ action: 'profile', state: 'waiting', scores: [] }]) });
  expect(await native.call('documents/document/review', 'GET', '', { canvasId })).toMatchObject({ blockId: native.block.id });
  await expect(native.call('documents/document/review', 'GET', `?canvasId=${canvasId}`,
    { principal: { ...owner, allowedCanvasIds: ['restricted'] } })).rejects.toMatchObject({ status: 404 });
  native.getCanvasSummary.mockResolvedValueOnce({ id: canvasId, workspaceId: 'other-workspace', blocks: [] });
  await expect(native.call('documents/document/review', 'GET', `?canvasId=${canvasId}`)).rejects.toMatchObject({ status: 404 });
  const approve = 'documents/document/approve-group';
  const approval = { canvasId, contentHash: hash, proposalId: 'missing-proposal' };
  await expect(native.call(approve, 'POST', '', { principal: { ...owner, canApprove: false }, input: approval }))
    .rejects.toMatchObject({ status: 403 });
  await expect(native.call(approve, 'POST', '', { input: {} })).rejects.toMatchObject({ status: 400 });
  await expect(native.call(approve, 'POST', '', { canvasId: 'other', input: approval })).rejects.toMatchObject({ status: 400 });
  await expect(native.call(approve, 'POST', '', { input: { ...approval, contentHash: '0'.repeat(16) } }))
    .rejects.toMatchObject({ status: 409 });
  await expect(native.call(approve, 'POST', '', { input: approval })).rejects.toMatchObject({ status: 409 });
  const recheck = 'documents/document/recheck';
  await expect(native.call(recheck, 'POST', '', { input: {} })).rejects.toMatchObject({ status: 400 });
  await expect(native.call(recheck, 'POST', '', { canvasId: 'other', input: { canvasId, contentHash: hash } }))
    .rejects.toMatchObject({ status: 400 });
  native.recheckDocument.mockRejectedValueOnce(new ApiError(503, 'Jev checks are paused for this app session'));
  await expect(native.call(recheck, 'POST', '', { input: { canvasId, contentHash: hash } }))
    .rejects.toMatchObject({ status: 503 });
  expect(await native.call(recheck, 'POST', '', { input: { canvasId, contentHash: hash } })).toEqual({ jobId: 'queued-offline' });
});

it('polls the newest permitted current revision, reuses a versioned hash, and drops stale or missing sources', async () => {
  const native = fixture();
  native.state.jobs.push(root('new', native.block.id, '2026-10-06T00:00:00Z'),
    root('old', native.block.id, '2026-10-05T00:00:00Z'),
    root('unpermitted', 'private', '2026-10-06T00:00:00Z', hash, 'restricted'),
    root('no-version', 'legacy', '2026-10-06T00:00:00Z'),
    root('deleted', 'gone', '2026-10-06T00:00:00Z'));
  native.getCanvasSummary.mockImplementation(async id => ({ id, workspaceId,
    blocks: id === canvasId ? [{ id: native.block.id, contentVersion: 'v1' }, { id: 'legacy' },
      { id: 'gone', contentVersion: 'v1' }] : [] }));
  const token: JevPrincipal = { id: 'reader', kind: 'token', access: 'read', allowedCanvasIds: [canvasId] };
  const first = await native.call('progress', 'GET', '', { principal: token }) as { documents: Array<{ jobId: string }> };
  expect(first.documents.map(item => item.jobId)).toEqual(['new']);
  expect(native.getCanvasBlock).toHaveBeenCalledTimes(2);
  expect((await native.call('progress', 'GET', '', { principal: token }) as typeof first).documents.map(item => item.jobId)).toEqual(['new']);
  expect(native.getCanvasBlock).toHaveBeenCalledTimes(3); // Only the removed document needs another checked lookup.
  native.block.contentHash = 'changed-hash';
  native.getCanvasSummary.mockImplementation(async id => ({ id, workspaceId,
    blocks: id === canvasId ? [{ id: native.block.id, contentVersion: 'v2' }] : [] }));
  expect((await native.call('progress', 'GET', '', { principal: token }) as typeof first).documents).toEqual([]);
  expect(native.getCanvasBlock).toHaveBeenCalledTimes(4);
});

it('keeps progress accurate while the versioned hash cache evicts its oldest entry', async () => {
  const native = fixture();
  const ids = Array.from({ length: 2_049 }, (_, index) => `offline-${index}`);
  native.state.jobs.push(...ids.map(id => root(`job-${id}`, id, '2026-10-06T00:00:00Z')));
  native.getCanvasSummary.mockImplementation(async id => ({ id, workspaceId,
    blocks: id === canvasId ? ids.map(blockId => ({ id: blockId, contentVersion: 'v1' })) : [] }));
  native.getCanvasBlock.mockImplementation(async (_canvas, id) => ({ ...native.block, id }));
  const polled = await native.call('progress') as { documents: Array<{ jobId: string }> };
  expect(polled.documents).toHaveLength(ids.length);
  expect(polled.documents[0].jobId).toBe('job-offline-0');
  expect(native.getCanvasBlock).toHaveBeenCalledTimes(ids.length);
});

it('rejects missing progress scope and propagates non-missing document errors', async () => {
  const native = fixture();
  const token: JevPrincipal = { id: 'reader', kind: 'token', access: 'read', allowedCanvasIds: [canvasId] };
  await expect(native.call('progress', 'GET', '?canvasId=restricted', { principal: token }))
    .rejects.toMatchObject({ status: 404 });
  await expect(native.call('progress', 'GET', '?canvasId=unknown')).rejects.toMatchObject({ status: 404 });
  native.listWorkspaces.mockResolvedValueOnce([]);
  await expect(native.call('progress')).rejects.toMatchObject({ status: 404 });
  native.state.jobs.push(root('current', native.block.id, '2026-10-06T00:00:00Z'));
  native.getCanvasBlock.mockRejectedValueOnce(new ApiError(503, 'Offline document read failed'));
  await expect(native.call('progress')).rejects.toMatchObject({ status: 503 });
});

it('inspects only current scoped decisions and rejects malformed or stale requests', async () => {
  const native = fixture();
  const current = root('inspect-root', native.block.id, '2026-10-06T00:00:00Z');
  native.state.jobs.push(current);
  await expect(native.call('inspect')).rejects.toMatchObject({ status: 400 });
  await expect(native.call('inspect', 'GET', '?jobId=unknown&action=profile')).rejects.toMatchObject({ status: 404 });
  await expect(native.call('inspect', 'GET', '?jobId=inspect-root&action=unknown')).rejects.toMatchObject({ status: 400 });
  await expect(native.call('inspect', 'GET', '?jobId=inspect-root&action=profile',
    { principal: { ...owner, allowedCanvasIds: ['restricted'] } })).rejects.toMatchObject({ status: 404 });
  await expect(native.call('inspect', 'GET', '?jobId=inspect-root&action=link')).rejects.toMatchObject({ status: 404 });
  expect(await native.call('inspect', 'GET', '?jobId=inspect-root&action=profile')).toMatchObject({ jobId: current.id });
  native.block.contentHash = 'new-revision';
  await expect(native.call('inspect', 'GET', '?jobId=inspect-root&action=profile')).rejects.toMatchObject({ status: 409 });
});
