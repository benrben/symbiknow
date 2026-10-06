import { expectRestoredCanvas } from './tests/restoration.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanvasStore } from './storage.js';
import { ChatProposalDraft, applyChatProposal, getChatProposal, undoChatProposal } from './chat-proposals.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-proposal-behavior-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  const canvas = await store.getCanvas('product-roadmap');
  return { store, canvas, draft: new ChatProposalDraft(store, canvas.id, canvas) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Chat proposal public controls', () => {
  it('keeps projected copies private, ignores undefined fields and omits cancelled or unchanged drafts', async () => {
    const { store, canvas, draft } = await fixture();
    expect(draft.publish()).toBeNull();
    const original = draft.get('launch-checklist');
    original.title = 'Local copy';
    expect(draft.get(original.id).title).not.toBe('Local copy');
    expect(draft.patch(original.id, { title: undefined }, 'edit')).toEqual(draft.get(original.id));
    expect(draft.publish()).toBeNull();
    const created = draft.create({ title: 'Cancelled', content: '# Draft' });
    expect(created).toMatchObject({ kind: 'markdown', x: 100, y: 100, width: 400, height: 320 });
    created.title = 'Local created copy';
    expect(draft.get(created.id).title).toBe('Cancelled');
    draft.delete(created.id);
    expect(draft.publish()).toBeNull();
    expect(() => draft.get(created.id)).toThrow(/not found/);
    expect(() => draft.delete('missing')).toThrow(/not found/);
    expect(await store.getCanvas(canvas.id)).toEqual(canvas);
  });

  it('publishes one immutable preview identity and preserves a later edit after a delete-shaped patch', async () => {
    const { draft } = await fixture();
    draft.patch('launch-checklist', { title: 'First' }, 'delete');
    draft.patch('launch-checklist', { title: 'Second' }, 'move');
    const proposal = draft.publish()!;
    expect(proposal.changes[0]).toMatchObject({ type: 'edit', title: 'Second' });
    expect(draft.publish()).toBe(proposal);
  });

  it('refuses empty, unknown and delete-only selections while reporting a skipped delete in a mixed apply', async () => {
    const { store, canvas, draft } = await fixture();
    draft.delete('launch-checklist');
    draft.patch('roadmap-overview', { title: 'Reviewed roadmap' }, 'edit');
    const proposal = draft.publish()!;
    await expect(applyChatProposal(store, proposal.id, [])).rejects.toMatchObject({ status: 400, message: 'Select at least one proposed change' });
    await expect(applyChatProposal(store, proposal.id, ['unknown'])).rejects.toMatchObject({ status: 400 });
    await expect(applyChatProposal(store, proposal.id, ['launch-checklist'])).rejects.toMatchObject({ status: 400, message: 'This proposal has no changes that can be safely applied' });
    expect(await store.getCanvas(canvas.id)).toEqual(canvas);
    const receipt = await applyChatProposal(store, proposal.id);
    expect(receipt).toMatchObject({ status: 'partial', applied: ['roadmap-overview'],
      skipped: [{ id: 'launch-checklist', reason: expect.stringContaining('Delete needs a reversible restore path') }] });
    expect((await store.getCanvas(canvas.id)).blocks.some(block => block.id === 'launch-checklist')).toBe(true);
    await expect(applyChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 410, message: expect.stringContaining('already been applied') });
    await undoChatProposal(store, proposal.id);
    expectRestoredCanvas(await store.getCanvas(canvas.id), canvas);
  });

  it('remaps selected new-document links and relation keys in both created and existing documents', async () => {
    const { store, canvas, draft } = await fixture();
    const first = draft.create({ title: 'First new', content: '# First', kind: 'mdx', x: -400, y: -500 });
    const second = draft.create({ title: 'Second new', content: '# Second', x: -900, y: -100 });
    draft.patch(first.id, { links: [second.id], linkTypes: { [second.id]: 'prerequisite' } }, 'link');
    draft.patch('launch-checklist', { links: [first.id], linkTypes: { [first.id]: 'implements' } }, 'link');
    const receipt = await applyChatProposal(store, draft.publish()!.id);
    const savedFirst = receipt.createdBlockIds[first.id];
    const savedSecond = receipt.createdBlockIds[second.id];
    const applied = await store.getCanvas(canvas.id);
    expect(applied.blocks.find(block => block.id === savedFirst)).toMatchObject({ kind: 'mdx', x: -400, y: -500,
      links: [savedSecond], linkTypes: { [savedSecond]: 'prerequisite' } });
    expect(applied.blocks.find(block => block.id === 'launch-checklist')).toMatchObject({
      links: [savedFirst], linkTypes: { [savedFirst]: 'implements' } });
    expect(receipt.documents.find(item => item.id === first.id)?.after).toEqual(applied.blocks.find(block => block.id === savedFirst));
    await undoChatProposal(store, receipt.id);
    expectRestoredCanvas(await store.getCanvas(canvas.id), canvas);
  });

  it('refuses a removed preview document and a removed applied document without changing surviving documents', async () => {
    const { store, canvas, draft } = await fixture();
    draft.patch('launch-checklist', { content: '# Proposed' }, 'edit');
    const proposal = draft.publish()!;
    await store.deleteBlock(canvas.id, 'launch-checklist');
    await expect(applyChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 409,
      conflicts: [{ id: 'launch-checklist', reason: 'Document changed since preview' }] });
    const nextCanvas = await store.getCanvas(canvas.id);
    const nextDraft = new ChatProposalDraft(store, canvas.id, nextCanvas);
    nextDraft.patch('roadmap-overview', { content: '# Proposed' }, 'edit');
    const next = nextDraft.publish()!;
    await applyChatProposal(store, next.id);
    await store.deleteBlock(canvas.id, 'roadmap-overview');
    const beforeUndo = await store.getCanvas(canvas.id);
    await expect(undoChatProposal(store, next.id)).rejects.toMatchObject({ status: 409 });
    expect(await store.getCanvas(canvas.id)).toEqual(beforeUndo);
  });

  it('refuses Undo for a pending proposal or an applied receipt with no documents', async () => {
    const { store, draft } = await fixture();
    draft.patch('launch-checklist', { title: 'Reviewed' }, 'edit');
    const proposal = draft.publish()!;
    await expect(undoChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 410 });
    await applyChatProposal(store, proposal.id);
    const file = path.join(store.root, 'chat-proposals', `${proposal.id}.json`);
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.receipt.documents = [];
    await writeFile(file, JSON.stringify(state));
    await expect(undoChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 410 });
  });

  it('rejects overlapping operations across stores sharing the same journal and releases the lock after failure', async () => {
    const { store, canvas, draft } = await fixture();
    draft.patch('launch-checklist', { title: 'Reviewed' }, 'edit');
    const proposal = draft.publish()!;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = store.getCanvas.bind(store);
    vi.spyOn(store, 'getCanvas').mockImplementationOnce(async (...args) => { entered(); await blocked; return original(...args); });
    const applying = applyChatProposal(store, proposal.id);
    await ready;
    const other = new CanvasStore(store.root);
    await expect(applyChatProposal(other, proposal.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already being applied') });
    await expect(undoChatProposal(other, proposal.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already being undone') });
    release();
    await applying;
    vi.spyOn(store, 'getCanvas').mockRejectedValueOnce(new Error('Read unavailable'));
    await expect(undoChatProposal(store, proposal.id)).rejects.toThrow('Read unavailable');
    expect(await undoChatProposal(other, proposal.id)).toMatchObject({ status: 'reverted' });
    expectRestoredCanvas(await other.getCanvas(canvas.id), canvas);
  });

  it('surfaces a blocked journal directory, then allows publishing after the filesystem is repaired', async () => {
    const { store, draft } = await fixture();
    draft.patch('launch-checklist', { title: 'Reviewed' }, 'edit');
    const directory = path.join(store.root, 'chat-proposals');
    await writeFile(directory, 'Directory unavailable');
    expect(() => draft.publish()).toThrow();
    await rm(directory);
    const proposal = draft.publish()!;
    expect(getChatProposal(store, proposal.id)).toEqual(proposal);
    expect(await readdir(directory)).toEqual([`${proposal.id}.json`]);
  });

  it('cleans temporary journal files when the final atomic rename is blocked by the filesystem', async () => {
    const { store, canvas, draft } = await fixture();
    draft.patch('launch-checklist', { title: 'Reviewed' }, 'edit');
    const proposal = draft.publish()!;
    const directory = path.join(store.root, 'chat-proposals');
    const file = path.join(directory, `${proposal.id}.json`);
    const update = store.updateBlock.bind(store);
    vi.spyOn(store, 'updateBlock').mockImplementationOnce(async (...args) => {
      const saved = await update(...args);
      await rm(file);
      await mkdir(file);
      return saved;
    });
    await expect(applyChatProposal(store, proposal.id)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(await readdir(directory)).toEqual([`${proposal.id}.json`]);
    expect((await store.getCanvas(canvas.id)).blocks.find(block => block.id === 'launch-checklist')?.title).toBe('Reviewed');
  });
});
