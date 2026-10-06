import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevJob, JevPrincipal, JevProposal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { currentPrincipal, requireWrite, scopedState } from './authorization.js';
import { sourceSnapshot } from './stamps.js';
import { emptyJevWorkspace } from './workspace.js';
let root: string; let store: CanvasStore;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'reflex-grants-')); store = new CanvasStore(root); await store.init(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('refreshes legacy persisted token access and rejects malformed server principals and read-only writes', async () => {
  const created = await store.createMcpToken('Legacy connection', 'read');
  const id = created.settings.mcpTokens![0].id;
  const file = path.join(root, 'settings.json'); const saved = JSON.parse(await readFile(file, 'utf8'));
  delete saved.mcpTokens[0].access; await writeFile(file, JSON.stringify(saved));
  const principal = await currentPrincipal(new CanvasStore(root), { id, kind: 'token', access: 'read' });
  expect(principal).toMatchObject({ access: 'write', canApprove: false, canConfigure: false });
  for (const invalid of [null, { id: '', kind: 'user' }, { id: 'forged', kind: 'untrusted' }]) {
    await expect(currentPrincipal(store, invalid as never)).rejects.toMatchObject({ status: 403 });
  }
  expect(() => requireWrite({ id: 'reader', kind: 'user', access: 'read' })).toThrowError(expect.objectContaining({ status: 403 }));
});

it('filters hidden connection destinations, moves and stored analysis context while retaining a source-scoped legacy job', async () => {
  const workspace = await store.createWorkspace({ name: 'Scopes' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Visible' });
  const hidden = await store.createCanvas(workspace.id, { name: 'Private' });
  const block = await store.createBlock(canvas.id, { title: 'Visible source', content: '# Visible source' });
  const source = sourceSnapshot(workspace.id, canvas.id, block);
  const principal: JevPrincipal = { id: 'scoped', kind: 'token', access: 'read', allowedCanvasIds: [canvas.id] };
  const now = new Date().toISOString();
  const job: JevJob = { id: 'visible', request: { action: 'profile', canvasId: canvas.id }, state: 'completed', createdAt: now, updatedAt: now,
    sources: [source], proposalIds: [], result: { status: 'profiled' } };
  const contextJob = { ...job, id: 'hidden-context', contextCanvasIds: [hidden.id] };
  const proposal: JevProposal = { id: 'hidden-link', jobId: job.id, action: 'link', title: 'Hidden connection', explanation: 'Scoped proposal',
    sources: [source], evidence: [], state: 'pending', createdAt: now,
    mutation: { kind: 'document', canvasId: canvas.id, blockId: block.id, patch: { crossLinks: [{ canvasId: hidden.id, blockId: 'private' }] } } };
  const state = emptyJevWorkspace(); state.jobs = [job, contextJob];
  state.proposals = [proposal, { ...proposal, id: 'hidden-move', mutation: { kind: 'move', canvasId: canvas.id, blockId: block.id, targetCanvasId: hidden.id } }];
  const visible = scopedState(state, principal);
  expect(visible.jobs.map(item => item.id)).toEqual(['visible']);
  expect(visible.proposals).toEqual([]);
  expect(visible.prepared).toEqual([]);
});
