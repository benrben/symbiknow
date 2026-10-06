import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanvasStore, contentHash } from './storage.js';
import { blockStateHash } from './block-state.js';

const roots: string[] = [];
const canvasId = 'product-roadmap';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-storage-operations-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  return store;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function mergeFixture() {
  const store = await fixture();
  const canvas = await store.getCanvas(canvasId);
  const keeper = canvas.blocks.find(block => block.id === 'roadmap-overview')!;
  const old = canvas.blocks.find(block => block.id === 'launch-flow')!;
  const input = { keepBlockId: keeper.id, mergeBlockIds: [old.id], content: '# Combined roadmap',
    expectedContentHashes: { [keeper.id]: keeper.contentHash, [old.id]: old.contentHash } };
  return { store, keeper, old, input };
}

describe('serialized public storage operations', () => {
  it('keeps a saved document durable when an asynchronous index listener fails', async () => {
    const store = await fixture();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = store.onSaved(async () => { throw new Error('index temporarily unavailable'); });
    try {
      const created = await store.createBlock(canvasId, { title: 'Saved while index is unavailable', content: '# Durable source' });
      await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(
        'Search index update failed; reconciliation will retry.', expect.objectContaining({ message: 'index temporarily unavailable' })));
      expect((await new CanvasStore(store.root).getCanvasBlock(canvasId, created.id)).content).toBe('# Durable source');
    } finally { release(); logged.mockRestore(); }
  });

  it('keeps current content in history when metadata uses an older snapshot', async () => {
    const store = await fixture();
    const snapshot = (await store.getCanvas(canvasId)).blocks[0];
    await writeFile(path.join(store.root, snapshot.file), '# Edited outside the app');
    const metadata = await store.documentMetadata(snapshot);
    expect(metadata.authors).toEqual(['SymbiKnow']);
    await store.documentMetadata(snapshot);
    expect((await store.documentHistory(canvasId, snapshot.id)).commits).toHaveLength(1);
    await store.switchDocumentBranch(canvasId, snapshot.id, 'main');
    expect((await store.getCanvas(canvasId)).blocks[0].content).toBe('# Edited outside the app');
  });

  it('previews restoring a revision without changing the current document', async () => {
    const store = await fixture();
    const block = (await store.getCanvas(canvasId)).blocks[0];
    const original = (await store.documentHistory(canvasId, block.id)).commits[0].id;
    await store.updateBlock(canvasId, block.id, { content: '# New draft', message: ' Draft review ' }, 'Writer');
    const preview = await store.previewDocumentVersion(canvasId, block.id, 'restore', original);
    expect(preview).toMatchObject({ before: '# New draft', after: block.content });
    expect((await store.documentHistory(canvasId, block.id)).commits[0]).toMatchObject({ message: 'Draft review', author: 'Writer' });
    expect((await store.getCanvas(canvasId)).blocks[0].content).toBe('# New draft');
    expect(await store.documentMetadata(block)).toMatchObject({ latestAuthor: 'Writer' });
  });

  it('persists checked quality, deduplicated cross links, and nullable markers through reload', async () => {
    const store = await fixture();
    const target = await store.createCanvas('acme-team', { name: 'References' });
    const reference = await store.createBlock(target.id, { title: 'Reference' });
    const link = { canvasId: target.id, blockId: reference.id, relation: 'related' as const, confidence: 0 };
    await store.updateBlock(canvasId, 'roadmap-overview', { quality: { score: 1, at: '2026-10-01T00:00:00Z' },
      crossLinks: [link, { ...link, confidence: 1 }], archived: true, stale: true });
    const reopened = new CanvasStore(store.root);
    expect((await reopened.getCanvas(canvasId)).blocks.some(block => block.id === 'roadmap-overview')).toBe(false);
    expect((await reopened.getCanvas(canvasId, true)).blocks[0]).toMatchObject({ crossLinks: [link], archived: true, stale: true,
      quality: { score: 1, at: '2026-10-01T00:00:00Z' } });
    await reopened.updateBlock(canvasId, 'roadmap-overview', { archived: null, stale: null, crossLinks: [] });
    const cleared = (await reopened.getCanvas(canvasId)).blocks[0];
    expect(cleared.archived).toBeUndefined();
    expect(cleared.stale).toBeUndefined();
    expect(cleared.crossLinks).toBeUndefined();
  });

  it.each([
    { linkTypes: 'invalid' }, { linkTypes: { 'launch-flow': 'unknown' } },
    { crossLinks: [{}] }, { crossLinks: [null] }, { crossLinks: [{ canvasId: 'BAD', blockId: 'launch-flow' }] },
    { crossLinks: [{ canvasId: 'another', blockId: 'launch-flow', confidence: -0.1 }] },
    { crossLinks: [{ canvasId: 'another', blockId: 'launch-flow', relation: 'unknown' }] },
    { quality: null }, { quality: { score: -1, at: '2026-10-01' } }, { quality: { score: 0.5, at: 'invalid' } },
    { quality: { score: '1', at: '2026-10-01' } }, { archived: 'yes' }, { stale: 'yes' },
  ])('rejects malformed reviewed metadata without writing: %j', async input => {
    const store = await fixture();
    const before = await store.getCanvas(canvasId, true);
    await expect(store.updateBlock(canvasId, 'roadmap-overview', input)).rejects.toMatchObject({ status: 400 });
    expect(await store.getCanvas(canvasId, true)).toEqual(before);
  });

  it('carries an active document lock to its new canvas', async () => {
    const store = await fixture();
    const destination = await store.createCanvas('acme-team', { name: 'Destination' });
    const original = (await store.getCanvas(canvasId)).blocks[0];
    const lock = await store.lockBlock(canvasId, original.id, 'Owner', {});
    await store.moveBlockToCanvas(canvasId, original.id, destination.id, 'Owner', blockStateHash(original));
    expect((await store.getCanvas(destination.id)).blocks[0].lock).toEqual(lock);
    await expect(store.updateBlock(destination.id, original.id, { title: 'Intruder edit' }, 'Other'))
      .rejects.toMatchObject({ status: 423 });
    await store.unlockBlock(destination.id, original.id, 'Owner', false);
    await store.updateBlock(destination.id, original.id, { title: 'Released edit' }, 'Other');
    expect((await store.getCanvas(destination.id)).blocks[0].title).toBe('Released edit');
  });

  it('rejects stale linked-source reviews and accepts the current cross-canvas version', async () => {
    const store = await fixture();
    const target = await store.createCanvas('acme-team', { name: 'Source' });
    const reference = await store.createBlock(target.id, { title: 'Linked source' });
    const expected = { canvasId: target.id, blockId: reference.id, hash: blockStateHash(reference) };
    await store.updateBlock(target.id, reference.id, { title: 'Changed source' });
    await expect(store.updateBlock(canvasId, 'roadmap-overview', { title: 'Reviewed title', expectedCrossTargetState: expected }))
      .rejects.toMatchObject({ status: 409 });
    await expect(store.updateBlock(canvasId, 'roadmap-overview', { expectedCrossTargetState: { canvasId: target.id } }))
      .rejects.toMatchObject({ status: 400 });
    const current = (await store.getCanvas(target.id)).blocks[0];
    const saved = await store.updateBlock(canvasId, 'roadmap-overview', { title: 'Reviewed title',
      expectedCrossTargetState: { ...expected, hash: blockStateHash(current) } });
    expect(saved.title).toBe('Reviewed title');
  });

  it('applies a superseding link atomically and checks both document locks', async () => {
    const store = await fixture();
    const action = { type: 'link' as const, fromBlockId: 'roadmap-overview', toBlockId: 'launch-flow', relation: 'supersedes' as const };
    await store.lockBlock(canvasId, action.toBlockId, 'Owner', {});
    await expect(store.updateInsightLink(canvasId, action, 'Other')).rejects.toMatchObject({ status: 423 });
    expect((await store.getCanvas(canvasId)).blocks.find(block => block.id === action.toBlockId)?.stale).toBeUndefined();
    await store.unlockBlock(canvasId, action.toBlockId, 'Owner', false);
    await store.updateInsightLink(canvasId, action, 'Other');
    const saved = await store.getCanvas(canvasId);
    expect(saved.blocks.find(block => block.id === action.fromBlockId)?.linkTypes).toEqual({ 'launch-flow': 'supersedes' });
    expect(saved.blocks.find(block => block.id === action.toBlockId)?.stale).toBe(true);
    const source = saved.blocks.find(block => block.id === action.fromBlockId)!;
    await store.updateBlock(canvasId, source.id, { title: 'New title' });
    await expect(store.updateInsightLink(canvasId, { ...action, type: 'unlink' }, 'Other', { [source.id]: blockStateHash(source) }))
      .rejects.toMatchObject({ status: 409 });
    await store.updateInsightLink(canvasId, { ...action, type: 'unlink' }, 'Other');
    const unlinked = (await store.getCanvas(canvasId)).blocks.find(block => block.id === source.id)!;
    expect(unlinked.links).not.toContain(action.toBlockId);
    expect(unlinked.linkTypes).toBeUndefined();
  });

  it('serializes task comments, rejects dependency cycles, and cleans removed dependencies', async () => {
    const store = await fixture();
    expect(await store.listTasks(canvasId)).toEqual([]);
    const first = await store.createTask(canvasId, { title: 'First', blockIds: ['roadmap-overview'] }, 'A');
    const second = await store.createTask(canvasId, { title: 'Second', dependsOnTaskIds: [first.id] }, 'A');
    await expect(store.updateTask(canvasId, first.id, { dependsOnTaskIds: [second.id] }, 'A'))
      .rejects.toMatchObject({ status: 400 });
    await Promise.all([store.commentTask(canvasId, first.id, 'One', 'A'), store.commentTask(canvasId, first.id, 'Two', 'B')]);
    const saved = (await store.listTasks(canvasId)).find(task => task.id === first.id)!;
    expect(saved.dependsOnTaskIds).toBeUndefined();
    expect(saved.comments.map(comment => comment.text)).toEqual(['One', 'Two']);
    await store.claimTask(canvasId, first.id, 'A', false);
    await expect(store.claimTask(canvasId, first.id, 'B', false)).rejects.toMatchObject({ status: 409 });
    expect(await store.claimTask(canvasId, first.id, 'B', true)).toMatchObject({ assignee: 'B', status: 'in_progress' });
    await store.deleteTask(canvasId, first.id);
    expect(await store.listTasks(canvasId)).toMatchObject([{ id: second.id, dependsOnTaskIds: [] }]);
    await expect(store.deleteTask(canvasId, first.id)).rejects.toMatchObject({ status: 404 });
  });

  it('validates task review versions and leaves the stored task intact after conflicts', async () => {
    const store = await fixture();
    const block = (await store.getCanvas(canvasId)).blocks[0];
    const task = await store.createTask(canvasId, { title: 'Review', blockIds: [block.id] }, 'Reviewer');
    await expect(store.updateTask(canvasId, task.id, { title: 'Stale', expectedUpdatedAt: 'older' }, 'Reviewer'))
      .rejects.toMatchObject({ status: 409 });
    await store.updateBlock(canvasId, block.id, { title: 'New document title' });
    await expect(store.updateTask(canvasId, task.id, { expectedSourceStateHashes: { [block.id]: blockStateHash(block) } }, 'Reviewer'))
      .rejects.toMatchObject({ status: 409 });
    await expect(store.updateTask(canvasId, task.id, { expectedSourceStateHashes: [] }, 'Reviewer'))
      .rejects.toMatchObject({ status: 409 });
    await expect(store.createTask(canvasId, { title: 'Foreign finding', findingRef: { canvasId: 'another' } }, 'Reviewer'))
      .rejects.toMatchObject({ status: 400 });
    expect((await store.listTasks(canvasId))[0].title).toBe('Review');
    const current = (await store.getCanvas(canvasId)).blocks[0];
    expect(await store.updateTask(canvasId, task.id, { title: 'Fresh', expectedUpdatedAt: task.updatedAt,
      expectedSourceStateHashes: { [current.id]: blockStateHash(current) } }, 'Reviewer')).toMatchObject({ title: 'Fresh' });
  });

  it('surfaces corrupt task state and resumes queued writes after repair', async () => {
    const store = await fixture();
    const tasksFile = path.join(store.root, 'tasks', `${canvasId}.json`);
    await store.createTask(canvasId, { title: 'Keep me' }, 'A');
    const previous = await readFile(tasksFile, 'utf8');
    await writeFile(tasksFile, '{');
    await expect(store.listTasks(canvasId)).rejects.toBeInstanceOf(SyntaxError);
    await expect(store.createTask(canvasId, { title: 'Blocked' }, 'A')).rejects.toBeInstanceOf(SyntaxError);
    await writeFile(tasksFile, previous);
    await store.createTask(canvasId, { title: 'After repair' }, 'A');
    expect((await store.listTasks(canvasId)).map(task => task.title)).toEqual(['Keep me', 'After repair']);
  });
});

describe('public merge and token persistence', () => {
  it('repoints attached tasks during merge and restores them on undo', async () => {
    const { store, keeper, old, input } = await mergeFixture();
    const task = await store.createTask(canvasId, { title: 'Review both', blockIds: [keeper.id, old.id] }, 'Reviewer');
    await store.commentTask(canvasId, task.id, 'Original context', 'Reviewer');
    const before = await store.listTasks(canvasId);
    const merged = await store.mergeDocuments(canvasId, input, 'Merger');
    expect((await store.listTasks(canvasId))[0]).toMatchObject({ blockIds: [keeper.id],
      comments: [{ text: 'Original context' }, { author: 'Merger', text: `Merged ${old.title} into ${keeper.title}` }] });
    await store.undoMerge(merged.mergeId, 'Merger');
    const restored = await store.listTasks(canvasId);
    expect(restored.map(task => ({ ...task, revision: 0 }))).toEqual(before.map(task => ({ ...task, revision: 0 })));
    expect(restored[0].revision).toBeGreaterThan(before[0].revision!);
    expect((await store.getCanvas(canvasId)).blocks.find(block => block.id === keeper.id)?.content).toBe(keeper.content);
  });

  it('refuses merge undo after linked-canvas references change', async () => {
    const { store, keeper, old, input } = await mergeFixture();
    const neighbor = await store.createCanvas('acme-team', { name: 'References' });
    const portal = await store.createBlock(neighbor.id, { title: 'Portal' });
    await store.updateBlock(neighbor.id, portal.id, { crossLinks: [{ canvasId, blockId: old.id, relation: 'related' }] });
    const merge = await store.mergeDocuments(canvasId, input);
    await store.updateBlock(neighbor.id, portal.id, { crossLinks: [{ canvasId, blockId: keeper.id, relation: 'prerequisite' }] });
    await expect(store.undoMerge(merge.mergeId)).rejects.toMatchObject({ status: 409 });
    expect((await store.getCanvas(canvasId)).blocks.some(block => block.id === old.id)).toBe(false);
  });

  it('refuses merge undo after attached task state changes', async () => {
    const { store, old, input } = await mergeFixture();
    const task = await store.createTask(canvasId, { title: 'Review', blockIds: [old.id] }, 'Reviewer');
    const merge = await store.mergeDocuments(canvasId, input);
    await store.commentTask(canvasId, task.id, 'Later context', 'Reviewer');
    await expect(store.undoMerge(merge.mergeId)).rejects.toMatchObject({ status: 409 });
    expect((await store.listTasks(canvasId))[0].comments.at(-1)?.text).toBe('Later context');
  });

  it('avoids a content commit when merged text equals the keeper', async () => {
    const { store, keeper, input } = await mergeFixture();
    const before = await store.documentHistory(canvasId, keeper.id);
    const merge = await store.mergeDocuments(canvasId, { ...input, content: keeper.content });
    expect(merge.contentHash).toBe(contentHash(keeper.content));
    expect((await store.documentHistory(canvasId, keeper.id)).commits).toEqual(before.commits);
    await store.undoMerge(merge.mergeId);
    await expect(store.undoMerge('invalid')).rejects.toMatchObject({ status: 400 });
    await expect(store.undoMerge('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    { keepBlockId: '../outside' }, { mergeBlockIds: [] }, { mergeBlockIds: ['launch-flow', 'launch-flow'] },
    { mergeBlockIds: ['roadmap-overview'] }, { mergeBlockIds: ['BAD'] }, { expectedContentHashes: null },
    { expectedContentHashes: [] }, { mergeBlockIds: Array.from({ length: 11 }, (_, index) => `doc-${index}`) },
  ])('rejects malformed merges before writing: %j', async patch => {
    const { store, input } = await mergeFixture();
    const before = await store.getCanvas(canvasId, true);
    await expect(store.mergeDocuments(canvasId, { ...input, ...patch })).rejects.toMatchObject({ status: 400 });
    expect(await store.getCanvas(canvasId, true)).toEqual(before);
  });

  it('enforces merge source hashes and locks before changing documents', async () => {
    const { store, keeper, old, input } = await mergeFixture();
    await expect(store.mergeDocuments(canvasId, { ...input, expectedContentHashes: { [keeper.id]: 'stale' } }))
      .rejects.toMatchObject({ status: 409 });
    await store.lockBlock(canvasId, old.id, 'Owner', {});
    await expect(store.mergeDocuments(canvasId, input, 'Other')).rejects.toMatchObject({ status: 423 });
    expect((await store.getCanvas(canvasId)).blocks.find(block => block.id === keeper.id)?.content).toBe(keeper.content);
  });

  it('persists hashed scoped tokens with private permissions and revokes them', async () => {
    const store = await fixture();
    expect(await store.mcpTokenIdentity('')).toBeNull();
    const created = await store.createMcpToken('Reader', 'read', { allowedCanvasIds: [canvasId], tools: ['read_doc'] });
    const summary = created.settings.mcpTokens![0];
    expect(await store.mcpTokenIdentity(created.token)).toMatchObject({ id: summary.id, name: 'Reader', access: 'read',
      allowedCanvasIds: [canvasId], tools: ['read_doc'] });
    // Drain the shared write queue after the advisory last-use update.
    await store.updateSettings({});
    const settingsFile = path.join(store.root, 'settings.json');
    expect((await stat(settingsFile)).mode & 0o777).toBe(0o600);
    const persisted = await readFile(settingsFile, 'utf8');
    expect(persisted).not.toContain(created.token);
    expect(JSON.parse(persisted).mcpTokens[0].lastUsedAt).toEqual(expect.any(String));
    expect(await store.verifyMcpToken(created.token)).toBe('Reader');
    await store.revokeMcpToken(summary.id);
    expect(await store.mcpTokenIdentity(created.token)).toBeNull();
    await expect(store.revokeMcpToken(summary.id)).rejects.toMatchObject({ status: 404 });
    await expect(store.createMcpToken('Unknown canvas', 'read', { allowedCanvasIds: ['missing'] }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('persists MCP activity even when document history is not available', async () => {
    const store = await fixture();
    expect(await store.mcpActivity()).toEqual({ entries: [] });
    expect(await store.mcpDocumentRevision('../bad')).toBeUndefined();
    expect(await store.mcpDocumentRevision('roadmap-overview')).toBeUndefined();
    const history = await store.documentHistory(canvasId, 'roadmap-overview');
    expect(await store.mcpDocumentRevision('roadmap-overview')).toBe(history.commits[0].id);
    const recorded = await store.recordMcpActivity({ tokenId: 'reader', tokenName: 'Reader', access: 'read', tool: 'read_doc',
      startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:00:01Z', outcome: 'success',
      canvasIds: [canvasId], documentIds: ['roadmap-overview'] });
    const reopened = new CanvasStore(store.root);
    expect((await reopened.mcpActivity()).entries).toEqual([recorded]);
  });
});
