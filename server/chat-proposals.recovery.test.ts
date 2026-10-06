import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanvasStore } from './storage.js';
import { ChatProposalDraft, applyChatProposal, getChatProposal, undoChatProposal } from './chat-proposals.js';
function expectRestoredCanvas(current: { blocks: import('../shared/types.js').CanvasBlock[] }, previous: typeof current) {
  const logical = (canvas: typeof current, original: typeof current) => ({ ...canvas, blocks: canvas.blocks.map(source => {
    const block = { ...source }; delete block.incarnation; delete block.sourceGeneration; delete block.metadataRevision; delete block.jevMutationId;
    if (!original.blocks.find(item => item.id === block.id)?.jevOwnership) delete block.jevOwnership;
    return block;
  }) });
  expect(logical(current, previous)).toEqual(logical(previous, previous));
  for (const block of current.blocks) {
    const old = previous.blocks.find(item => item.id === block.id)!;
    if (old.incarnation) expect(block.incarnation).toBe(old.incarnation);
    if (block.sourceGeneration) expect(block.sourceGeneration).toBeGreaterThanOrEqual(old.sourceGeneration ?? 0);
  }
}


const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-proposal-recovery-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  const canvas = await store.getCanvas('product-roadmap');
  const draft = new ChatProposalDraft(store, canvas.id, canvas);
  return { store, canvas, draft };
}
function journal(store: CanvasStore, id: string) { return path.join(store.root, 'chat-proposals', `${id}.json`); }
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Chat proposal recovery boundaries', () => {
  it('refuses a corrupted numeric snapshot content as unavailable, before any document write', async () => {
    const { store, canvas, draft } = await fixture();
    draft.patch('launch-checklist', { content: '# Proposed' }, 'edit');
    const proposal = draft.publish()!;
    const file = journal(store, proposal.id);
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.proposal.changes[0].before.content = 123;
    await writeFile(file, JSON.stringify(state));
    await expect(applyChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 410 });
    expectRestoredCanvas(await store.getCanvas(canvas.id), canvas);
  });

  it('records an interrupted apply even when the storage rejection has no error object', async () => {
    const { store, canvas, draft } = await fixture();
    draft.patch('launch-checklist', { content: '# Proposed' }, 'edit');
    const proposal = draft.publish()!;
    vi.spyOn(store, 'updateBlock').mockRejectedValueOnce(null);
    const receipt = await applyChatProposal(store, proposal.id);
    expect(receipt).toMatchObject({ status: 'partial', applied: [], documents: [],
      skipped: [{ id: 'launch-checklist', reason: 'Apply stopped: The save stopped unexpectedly' }] });
    expect(getChatProposal(store, proposal.id)).toEqual(receipt);
    expectRestoredCanvas(await store.getCanvas(canvas.id), canvas);
    await expect(undoChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 410 });
  });

  it('recovers multiple created saves, skips a creation that never ran, and keeps an unrelated new document', async () => {
    const { store, canvas, draft } = await fixture();
    const first = draft.create({ title: 'First saved', content: '# First', x: -800 });
    const second = draft.create({ title: 'Second saved', content: '# Second', x: -1600 });
    const third = draft.create({ title: 'Never saved', content: '# Third', x: -2400 });
    const proposal = draft.publish()!;
    const create = store.createBlock.bind(store);
    let calls = 0;
    vi.spyOn(store, 'createBlock').mockImplementation(async (...args) => {
      const saved = await create(...args);
      if (++calls === 2) {
        await create(canvas.id, { title: 'Never saved', content: '# Unrelated content', x: -3200 });
        throw 'Response lost';
      }
      return saved;
    });
    const receipt = await applyChatProposal(store, proposal.id);
    expect(receipt).toMatchObject({ status: 'partial', applied: [first.id, second.id],
      skipped: [{ id: third.id, reason: 'Apply stopped: The save stopped unexpectedly' }] });
    expect(receipt.documents).toHaveLength(2);
    expect(receipt.createdBlockIds).toEqual({ [first.id]: expect.any(String), [second.id]: expect.any(String) });
    expect(await undoChatProposal(store, proposal.id)).toMatchObject({ status: 'reverted', reverted: [first.id, second.id] });
    expect((await store.getCanvas(canvas.id)).blocks.filter(block => !canvas.blocks.some(original => original.id === block.id)))
      .toMatchObject([{ title: 'Never saved', content: '# Unrelated content' }]);
  });

  it('keeps a created receipt retryable when deleting it during Undo fails without an error object', async () => {
    const { store, canvas, draft } = await fixture();
    const created = draft.create({ title: 'Retry Undo', content: '# Retry' });
    const proposal = draft.publish()!;
    const receipt = await applyChatProposal(store, proposal.id);
    vi.spyOn(store, 'deleteBlock').mockRejectedValueOnce('Unavailable');
    expect(await undoChatProposal(store, proposal.id)).toMatchObject({ status: 'partial', reverted: [],
      skipped: [{ id: created.id, reason: 'Undo stopped before every change was reverted' }] });
    expect((await store.getCanvas(canvas.id)).blocks.some(block => block.id === receipt.createdBlockIds[created.id])).toBe(true);
    expect(await undoChatProposal(store, proposal.id)).toMatchObject({ status: 'reverted', reverted: [created.id] });
    expectRestoredCanvas(await store.getCanvas(canvas.id), canvas);
  });

  it('restores saved metadata and tags as well as content after an edit', async () => {
    const { store, canvas } = await fixture();
    await store.updateBlock(canvas.id, 'roadmap-overview', { tags: ['original'], group: 'custom:original',
      purpose: 'Original purpose', reviewer: 'Reviewer', workArea: 'Area', links: ['launch-checklist'],
      linkTypes: { 'launch-checklist': 'prerequisite' }, width: 520, height: 270 });
    const before = await store.getCanvas(canvas.id);
    const draft = new ChatProposalDraft(store, canvas.id, before);
    draft.patch('roadmap-overview', { content: '# Revised', links: [], linkTypes: {} }, 'edit');
    const proposal = draft.publish()!;
    await applyChatProposal(store, proposal.id);
    await undoChatProposal(store, proposal.id);
    expectRestoredCanvas(await store.getCanvas(canvas.id), before);
  });
});
