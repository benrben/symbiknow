import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import type { Server } from 'node:http';
import { CanvasStore } from './storage.js';
import { ChatProposalDraft, ChatProposalConflict, applyChatProposal, getChatProposal, undoChatProposal } from './chat-proposals.js';
import { createChatStream, type DeepAgentFactory } from './chat-stream.js';
import { createApiServer } from './index.js';

const directories: string[] = [];
const servers: Server[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-proposal-'));
  directories.push(root);
  const store = new CanvasStore(root);
  await store.init();
  return store;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllGlobals();
});

describe('Chat document proposals', () => {
  it('recovers a pending preview after restart, then applies and undoes its saved receipt after another restart', async () => {
    const store = await fixture();
    const canvas = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, canvas.id, canvas);
    const created = draft.create({ title: 'Restart draft', content: '# Created for review' });
    draft.patch('launch-checklist', { content: '# Edited after restart', x: 520 }, 'edit');
    const proposal = draft.publish()!;
    const pendingStore = new CanvasStore(store.root);
    await pendingStore.init();
    expect(getChatProposal(pendingStore, proposal.id)).toEqual(proposal);
    expect(await pendingStore.getCanvas(canvas.id)).toEqual(canvas);
    const receipt = await applyChatProposal(pendingStore, proposal.id);
    expect(receipt).toMatchObject({ status: 'applied', applied: expect.arrayContaining([created.id, 'launch-checklist']) });
    const receiptStore = new CanvasStore(store.root);
    await receiptStore.init();
    expect(getChatProposal(receiptStore, proposal.id)).toEqual(receipt);
    expect(await undoChatProposal(receiptStore, proposal.id)).toMatchObject({ status: 'reverted' });
    expect(await receiptStore.getCanvas(canvas.id)).toEqual(canvas);
    expect(() => getChatProposal(receiptStore, proposal.id)).toThrow(/no longer available/);
  });

  it('keeps the stale hash guard after restart', async () => {
    const store = await fixture();
    const canvas = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, canvas.id, canvas);
    draft.patch('launch-checklist', { content: '# Proposed' }, 'edit');
    const proposal = draft.publish()!;
    await store.updateBlock(canvas.id, 'launch-checklist', { title: 'Changed elsewhere' });
    const restarted = new CanvasStore(store.root);
    await restarted.init();
    const beforeApply = await restarted.getCanvas(canvas.id);
    await expect(applyChatProposal(restarted, proposal.id)).rejects.toMatchObject({ status: 409,
      conflicts: [{ id: 'launch-checklist', reason: 'Document changed since preview' }],
    });
    expect(await restarted.getCanvas(canvas.id)).toEqual(beforeApply);
  });

  it('refuses expired and malformed persisted previews', async () => {
    const store = await fixture();
    const canvas = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, canvas.id, canvas);
    draft.patch('launch-checklist', { content: '# Proposed' }, 'edit');
    const proposal = draft.publish()!;
    const file = path.join(store.root, 'chat-proposals', `${proposal.id}.json`);
    const state = JSON.parse(await readFile(file, 'utf8')) as { expires: number };
    await writeFile(file, JSON.stringify({ ...state, expires: Date.now() - 1 }));
    const restarted = new CanvasStore(store.root);
    await restarted.init();
    await expect(applyChatProposal(restarted, proposal.id)).rejects.toMatchObject({ status: 410 });
    expect(await restarted.getCanvas(canvas.id)).toEqual(canvas);
    await writeFile(file, '{"version":1,"kind":"pending","proposal":{"id":"bad"}}');
    expect(() => getChatProposal(restarted, proposal.id)).toThrow(/no longer available/);
    const secondDraft = new ChatProposalDraft(restarted, canvas.id, canvas);
    secondDraft.patch('launch-checklist', { content: '# Applied before expiry' }, 'edit');
    const second = secondDraft.publish()!;
    await applyChatProposal(restarted, second.id);
    const receiptFile = path.join(store.root, 'chat-proposals', `${second.id}.json`);
    const receiptState = JSON.parse(await readFile(receiptFile, 'utf8')) as { expires: number };
    await writeFile(receiptFile, JSON.stringify({ ...receiptState, expires: Date.now() - 1 }));
    const afterRestart = new CanvasStore(store.root);
    await afterRestart.init();
    await expect(undoChatProposal(afterRestart, second.id)).rejects.toMatchObject({ status: 410 });
  });

  it('keeps create, edit, move, and link on a draft until selected changes are applied', async () => {
    const store = await fixture();
    const before = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, before.id, before);
    const created = draft.create({ title: 'Agent plan', content: '# Agent plan' });
    draft.patch(created.id, { x: 700, y: -80 }, 'move');
    draft.patch(created.id, { links: ['roadmap-overview'], linkTypes: { 'roadmap-overview': 'prerequisite' } }, 'link');
    const original = before.blocks.find(block => block.id === 'launch-checklist')!;
    draft.patch(original.id, { content: '# Revised checklist', title: 'Revised checklist' }, 'edit');
    const proposal = draft.publish()!;
    expect(proposal.changes).toHaveLength(2);
    expect(proposal.changes.find(change => change.blockId === original.id)).toMatchObject({
      before: { content: original.content }, after: { content: '# Revised checklist' }, expectedContentHash: original.contentHash,
    });
    expect(await store.getCanvas(before.id)).toEqual(before);
    const receipt = await applyChatProposal(store, proposal.id, [created.id]);
    expect(receipt).toMatchObject({ status: 'applied', applied: [created.id], skipped: [] });
    const savedId = receipt.createdBlockIds[created.id];
    expect(savedId).toBeTruthy();
    expect(receipt.documents[0].after).toMatchObject({ id: savedId, title: 'Agent plan', links: ['roadmap-overview'] });
    const after = await store.getCanvas(before.id);
    expect(after.blocks.find(block => block.id === savedId)).toMatchObject({ x: 700, y: -80, links: ['roadmap-overview'] });
    expect(after.blocks.find(block => block.id === original.id)?.content).toBe(original.content);
  });

  it('rejects invalid selections and links to an unselected new document without writing', async () => {
    const store = await fixture();
    const canvas = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, canvas.id, canvas);
    const created = draft.create({ title: 'Linked draft', content: '# Linked draft' });
    draft.patch('launch-checklist', { links: [created.id] }, 'link');
    const proposal = draft.publish()!;
    await expect(applyChatProposal(store, proposal.id, [created.id, created.id])).rejects.toMatchObject({ status: 400 });
    await expect(applyChatProposal(store, proposal.id, ['launch-checklist'])).rejects.toMatchObject({ status: 400,
      message: 'Select the new documents referenced by the selected links',
    });
    expect(await store.getCanvas(canvas.id)).toEqual(canvas);
    expect(getChatProposal(store, proposal.id)).toMatchObject({ status: 'pending' });
  });

  it('recovers a created document saved just before an Apply failure and keeps its Undo receipt', async () => {
    const store = await fixture();
    const canvas = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, canvas.id, canvas);
    const created = draft.create({ title: 'Saved before failure', content: '# Saved before failure' });
    const proposal = draft.publish()!;
    const original = store.createBlock.bind(store);
    vi.spyOn(store, 'createBlock').mockImplementation(async (...args) => {
      await original(...args);
      throw new Error('Response lost after save');
    });
    const receipt = await applyChatProposal(store, proposal.id);
    expect(receipt).toMatchObject({ status: 'partial', applied: [created.id], documents: [{ before: null,
      after: { title: 'Saved before failure', content: '# Saved before failure' } }] });
    expect(receipt.createdBlockIds[created.id]).toBeTruthy();
    const restarted = new CanvasStore(store.root);
    await restarted.init();
    expect(getChatProposal(restarted, proposal.id)).toEqual(receipt);
    expect(await undoChatProposal(restarted, proposal.id)).toMatchObject({ status: 'reverted', reverted: [created.id] });
    expect(await restarted.getCanvas(canvas.id)).toEqual(canvas);
  });

  it('rejects stale content or metadata before writing any selected change', async () => {
    const store = await fixture();
    const canvas = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, canvas.id, canvas);
    draft.patch('launch-checklist', { content: '# Proposed' }, 'edit');
    draft.patch('roadmap-overview', { x: 900 }, 'move');
    const proposal = draft.publish()!;
    await store.updateBlock(canvas.id, 'launch-checklist', { title: 'Changed elsewhere' });
    const beforeApply = await store.getCanvas(canvas.id);
    await expect(applyChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 409,
      conflicts: [{ id: 'launch-checklist', reason: 'Document changed since preview' }],
    } satisfies Partial<ChatProposalConflict>);
    expect(await store.getCanvas(canvas.id)).toEqual(beforeApply);
  });

  it('refuses undo after a later edit', async () => {
    const store = await fixture();
    const before = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, before.id, before);
    const created = draft.create({ title: 'New draft', content: '# Draft' });
    draft.patch('launch-checklist', { content: '# New checklist' }, 'edit');
    const proposal = draft.publish()!;
    const receipt = await applyChatProposal(store, proposal.id);
    await store.updateBlock(before.id, 'launch-checklist', { content: '# Changed after apply' });
    await expect(undoChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 409 });
    expect((await store.getCanvas(before.id)).blocks.some(block => block.id === receipt.createdBlockIds[created.id])).toBe(true);
  });

  it('undoes a clean applied edit and create', async () => {
    const store = await fixture();
    const before = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, before.id, before);
    const created = draft.create({ title: 'New draft', content: '# Draft' });
    draft.patch('launch-checklist', { content: '# New checklist' }, 'edit');
    const proposal = draft.publish()!;
    await applyChatProposal(store, proposal.id);
    const undone = await undoChatProposal(store, proposal.id);
    expect(undone).toMatchObject({ status: 'reverted', reverted: expect.arrayContaining([created.id, 'launch-checklist']) });
    expect(await store.getCanvas(before.id)).toEqual(before);
  });

  it('reports a partial apply with saved snapshots and keeps Undo available', async () => {
    const store = await fixture();
    const canvas = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, canvas.id, canvas);
    draft.patch('launch-checklist', { content: '# First applied' }, 'edit');
    draft.patch('roadmap-overview', { content: '# Second proposed' }, 'edit');
    const proposal = draft.publish()!;
    const original = store.updateBlock.bind(store);
    let calls = 0;
    vi.spyOn(store, 'updateBlock').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('Storage became unavailable');
      return original(...args);
    });
    const receipt = await applyChatProposal(store, proposal.id);
    expect(receipt).toMatchObject({ status: 'partial', applied: ['launch-checklist'],
      skipped: [{ id: 'roadmap-overview', reason: expect.stringContaining('Storage became unavailable') }],
      documents: [{ after: { content: '# First applied' } }],
    });
    expect((await store.getCanvas(canvas.id)).blocks.find(block => block.id === 'roadmap-overview')?.content)
      .toBe(canvas.blocks.find(block => block.id === 'roadmap-overview')?.content);
    expect(await undoChatProposal(store, proposal.id)).toMatchObject({ status: 'reverted', reverted: ['launch-checklist'] });
  });

  it('reports partial Undo and allows retry for remaining applied changes', async () => {
    const store = await fixture();
    const canvas = await store.getCanvas('product-roadmap');
    const draft = new ChatProposalDraft(store, canvas.id, canvas);
    draft.patch('launch-checklist', { content: '# First applied' }, 'edit');
    draft.patch('roadmap-overview', { content: '# Second applied' }, 'edit');
    const proposal = draft.publish()!;
    await applyChatProposal(store, proposal.id);
    const original = store.updateBlock.bind(store);
    let calls = 0;
    const spy = vi.spyOn(store, 'updateBlock').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('Undo stopped');
      return original(...args);
    });
    expect(await undoChatProposal(store, proposal.id)).toMatchObject({ status: 'partial', reverted: ['launch-checklist'],
      skipped: [{ id: 'roadmap-overview', reason: 'Undo stopped' }] });
    spy.mockRestore();
    expect(await undoChatProposal(store, proposal.id)).toMatchObject({ status: 'reverted', reverted: ['roadmap-overview'] });
    expect(await store.getCanvas(canvas.id)).toEqual(canvas);
  });

  it('emits a full proposal from Chat, with no saved document before Apply', async () => {
    const store = await fixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    const before = await store.getCanvas('product-roadmap');
    const factory: DeepAgentFactory = (_settings, tools) => async function* (messages) {
      expect(tools.map(item => item.name)).not.toContain('delete_doc');
      expect(tools.map(item => item.name)).not.toContain('organize_canvas');
      const edit = tools.find(item => item.name === 'edit_doc')!;
      expect(await edit.invoke({ blockId: 'launch-checklist', content: '# Proposed checklist' })).toContain('"saved":false');
      yield { messages: [...messages, new AIMessage('I prepared a proposal for review.')] };
    };
    const session = await createChatStream(store, { canvasId: before.id, messages: [{ role: 'user', content: 'Edit the checklist' }] }, factory);
    const events = [];
    for await (const event of session.events!(new AbortController().signal)) events.push(event);
    const proposal = events.find(event => event.kind === 'proposal');
    expect(proposal).toMatchObject({ kind: 'proposal', proposal: { canvasId: before.id, changes: [{ before: { content: expect.any(String) }, after: { content: '# Proposed checklist' } }] } });
    expect(await store.getCanvas(before.id)).toEqual(before);
  });

  it('serves proposal, Apply, and Undo through the HTTP contract', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-proposal-http-'));
    directories.push(root);
    const factory: DeepAgentFactory = (_settings, tools) => async function* (messages) {
      await tools.find(item => item.name === 'edit_doc')!.invoke({ blockId: 'launch-checklist', content: '# HTTP proposal' });
      yield { messages: [...messages, new AIMessage('Review this edit.') ] };
    };
    const server = await createApiServer({ dataDir: root, agentFactory: factory });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const store = new CanvasStore(root);
    await store.init();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    const base = `http://127.0.0.1:${address.port}`;
    const streamed = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Edit the checklist' }] }) });
    expect(streamed.status).toBe(200);
    const sse = await streamed.text();
    const match = /event: chat_proposal\ndata: ([^\n]+)/.exec(sse);
    expect(match).toBeTruthy();
    const proposal = JSON.parse(match![1]) as { id: string };
    const pending = await fetch(`${base}/api/chat/proposals/${proposal.id}`);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({ status: 'pending', expiresAt: expect.any(String) });
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'launch-checklist')?.content).not.toBe('# HTTP proposal');
    const response = await fetch(`${base}/api/chat/proposals/${proposal.id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'applied', documents: [{ after: { content: '# HTTP proposal' } }] });
    const applied = await fetch(`${base}/api/chat/proposals/${proposal.id}`);
    expect(await applied.json()).toMatchObject({ status: 'applied' });
    const undone = await fetch(`${base}/api/chat/proposals/${proposal.id}/undo`, { method: 'POST' });
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ status: 'reverted' });
    const secondStream = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Edit the checklist again' }] }) });
    const secondMatch = /event: chat_proposal\ndata: ([^\n]+)/.exec(await secondStream.text());
    const second = JSON.parse(secondMatch![1]) as { id: string };
    await store.updateBlock('product-roadmap', 'launch-checklist', { title: 'Changed while reviewing' });
    const conflict = await fetch(`${base}/api/chat/proposals/${second.id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ conflicts: [{ id: 'launch-checklist' }] });
  });
});
