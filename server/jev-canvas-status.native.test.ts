import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { createApiServer } from './index.js';
import { JevWorkspaceFiles, emptyJevWorkspace } from './jev/workspace.js';
import { sourceSnapshot } from './jev/stamps.js';
import type { JevProposal, JevReceipt } from '../shared/jev-types.js';
import type { CanvasDocument } from '../shared/types.js';
import { canvasJevStatusRevision, projectCanvasJevStatus } from './jev-canvas-status.js';

const fixtures: Array<{ root: string; server: Server }> = [];
afterEach(async () => {
  for (const { root, server } of fixtures.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-card-status-'));
  const server = await createApiServer({ dataDir: root }); fixtures.push({ root, server });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No native API address');
  const store = new CanvasStore(root);
  const workspace = await store.createWorkspace({ name: 'Launch evidence' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Launch' });
  const left = await store.createBlock(canvas.id, { title: 'Rollback runbook', content: '# Release\nRestore prior deployment.' });
  const right = await store.createBlock(canvas.id, { title: 'Rollback copy', content: left.content });
  const files = new JevWorkspaceFiles(root); const state = emptyJevWorkspace();
  const proposal: JevProposal = { id: 'duplicate-finding', jobId: 'compare', action: 'flag_duplicate',
    title: 'Compare possible duplicates', explanation: 'Exact source bytes', createdAt: new Date().toISOString(),
    state: 'applied', receiptId: 'duplicate-receipt', confidence: 1, evidence: [],
    sources: [left, right].map(block => sourceSnapshot(workspace.id, canvas.id, block)),
    mutation: { kind: 'derived', blockId: left.id, values: { kind: 'duplicate', targetId: right.id, targetCanvasId: canvas.id } } };
  const receipt: JevReceipt = { id: 'duplicate-receipt', proposalId: proposal.id, action: proposal.action,
    actor: 'jev-workspace-automation', automatic: true, state: 'applied', createdAt: proposal.createdAt,
    before: proposal.mutation, after: proposal.mutation, sourcesAfter: proposal.sources };
  state.proposals.push(proposal); state.receipts.push(receipt);
  const route = `http://127.0.0.1:${address.port}/api/canvases/${canvas.id}`;
  return { root, store, canvas, left, right, state, proposal, receipt, files, route, workspace };
}

it('projects a current saved duplicate on both cards, refreshes ETags and clears stale findings without changing source history', async () => {
  const f = await fixture();
  const before = await fetch(f.route); const etag = before.headers.get('etag')!;
  const history = await f.store.documentHistory(f.canvas.id, f.left.id);
  await f.files.write(f.workspace.id, f.state);
  const result = await fetch(f.route, { headers: { 'if-none-match': etag } });
  expect(result.status).toBe(200); expect(result.headers.get('etag')).not.toBe(etag);
  const saved = await result.json() as CanvasDocument;
  expect(saved.blocks.find(block => block.id === f.left.id)?.jevDuplicates).toEqual([{ findingId: f.proposal.id, blockId: f.right.id, title: f.right.title }]);
  expect(saved.blocks.find(block => block.id === f.right.id)?.jevDuplicates?.[0].blockId).toBe(f.left.id);
  const summary = await fetch(f.route + '?summary=1').then(response => response.json()) as CanvasDocument;
  expect(summary.blocks.map(block => block.jevDuplicates)).toEqual(saved.blocks.map(block => block.jevDuplicates));
  expect((await fetch(f.route, { headers: { 'if-none-match': result.headers.get('etag')! } })).status).toBe(304);
  expect(await f.store.documentHistory(f.canvas.id, f.left.id)).toEqual(history);
  expect((await f.store.getCanvasBlock(f.canvas.id, f.left.id)).jevDuplicates).toBeUndefined();
  await f.store.updateBlock(f.canvas.id, f.right.id, { content: '# Release\nA distinct recovery update.' });
  const changed = await fetch(f.route).then(response => response.json()) as CanvasDocument;
  expect(changed.blocks.every(block => block.jevDuplicates === undefined)).toBe(true);
});

it('ignores held, foreign, excluded, old-incarnation and undone findings and coalesces repeated endpoint checks', async () => {
  const f = await fixture();
  f.state.proposals.push({ ...f.proposal, id: 'same-pair' });
  f.state.receipts.push({ ...f.receipt, proposalId: 'same-pair' });
  await f.files.write(f.workspace.id, f.state);
  expect((await projectCanvasJevStatus(f.store, await f.store.getCanvasSummary(f.canvas.id))).blocks.every(block => block.jevDuplicates?.length === 1)).toBe(true);
  for (const change of [
    () => { f.proposal.state = 'dismissed'; },
    () => { f.proposal.sources[0].canvasId = 'foreign'; },
    () => { f.proposal.sources[0].incarnation = 'old'; },
    () => { f.receipt.state = 'undone'; f.state.receipts[1].state = 'undone'; },
    () => { f.proposal.action = 'link'; },
    () => { f.proposal.mutation = { kind: 'derived', values: { kind: 'conflict' } }; },
    () => { f.proposal.sources[0].workspaceId = 'foreign'; },
  ]) {
    const proposal = structuredClone(f.proposal); const receipts = structuredClone(f.state.receipts);
    f.state.proposals = [f.proposal]; change(); await f.files.write(f.workspace.id, f.state);
    const saved = await projectCanvasJevStatus(f.store, await f.store.getCanvasSummary(f.canvas.id));
    expect(saved.blocks.every(block => block.jevDuplicates === undefined)).toBe(true);
    Object.assign(f.proposal, proposal); f.state.receipts = receipts; f.receipt = f.state.receipts[0];
  }
  await f.store.updateBlock(f.canvas.id, f.right.id, { processingExcluded: true });
  await f.files.write(f.workspace.id, f.state);
  expect((await projectCanvasJevStatus(f.store, await f.store.getCanvasSummary(f.canvas.id))).blocks.every(block => block.jevDuplicates === undefined)).toBe(true);
});

it('keeps documents available with visible recovery status when the Reflex ledger is corrupt and recovers after repair', async () => {
  const f = await fixture(); await f.files.write(f.workspace.id, f.state);
  await writeFile(f.files.file(f.workspace.id), '{broken');
  const response = await fetch(f.route + '?summary=1'); expect(response.status).toBe(200);
  const saved = await response.json() as CanvasDocument;
  expect(saved.jevStatusError).toContain('Automatic findings could not load'); expect(saved.blocks).toHaveLength(2);
  expect(canvasJevStatusRevision('"source"', saved)).not.toBe('"source"');
  await f.files.write(f.workspace.id, f.state);
  expect((await fetch(f.route).then(response => response.json())).jevStatusError).toBeUndefined();
});

it('ignores deleted targets and makes a document read failure visible instead of marking unverified pairs', async () => {
  const f = await fixture(); await f.files.write(f.workspace.id, f.state);
  await rm(path.join(f.root, f.right.file));
  const projection = await projectCanvasJevStatus(f.store, await f.store.getCanvasSummary(f.canvas.id));
  expect(projection.blocks.every(block => block.jevDuplicates === undefined)).toBe(true);
  await writeFile(path.join(f.root, f.right.file), f.right.content);
  await rm(path.join(f.root, f.right.file));
  await (await import('node:fs/promises')).mkdir(path.join(f.root, f.right.file));
  const recovery = await projectCanvasJevStatus(f.store, f.canvas);
  expect(recovery.jevStatusError).toContain('Automatic findings could not load');
});

it('drops a finding whose endpoint was deleted while keeping the remaining source usable', async () => {
  const f = await fixture();
  await f.store.deleteBlock(f.canvas.id, f.right.id);
  await f.files.write(f.workspace.id, f.state);
  const projection = await projectCanvasJevStatus(f.store, await f.store.getCanvasSummary(f.canvas.id));
  expect(projection.jevStatusError).toBeUndefined();
  expect(projection.blocks).toHaveLength(1);
  expect(projection.blocks[0].jevDuplicates).toBeUndefined();
});
