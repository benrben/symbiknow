import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { CanvasBlock } from '../shared/types.js';
import type { JevMutation, JevPrincipal, JevProposal, JevSourceSnapshot } from '../shared/jev-types.js';
import { CanvasStore } from './storage.js';
import { atomicJson } from './storage-files.js';
import { storedBlock } from './storage-shapes.js';
import { JevProposalExecutor, type StoredJevReceipt } from './jev/proposals.js';
import { sourceSnapshot } from './jev/stamps.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './jev/workspace.js';

const roots: string[] = [];
const owner: JevPrincipal = { id: 'native-reviewer', kind: 'user', access: 'write', canApprove: true };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function block(canvasId: string, index: number): CanvasBlock {
  const id = `${canvasId}-${index}`;
  return { id, title: `Native source ${index}`, file: `docs/${id}.md`, kind: 'markdown',
    content: `# Native source ${index}\nA checked requirement for ${canvasId}.`, x: 17 + index, y: 29, width: 280, height: 180,
    links: [], tags: ['Manual tag'], incarnation: `${id}-original`, sourceGeneration: 1, metadataRevision: 1,
    jevOwnership: { pins: ['tags'], managed: ['headline', 'group', 'links'], removedLabels: [], removedLinks: [] } };
}
async function fixture(count = 3) {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-postwrite-snapshots-')); roots.push(root);
  await Promise.all(['docs', 'canvases'].map(directory => mkdir(path.join(root, directory))));
  const primary = Array.from({ length: count }, (_, index) => block('primary', index));
  const target = [block('target', 0), block('target', 1)];
  const canvases = [{ id: 'primary', name: 'Sources', workspaceId: 'workspace', blocks: primary.map(storedBlock) },
    { id: 'target', name: 'Delivery', workspaceId: 'workspace', blocks: target.map(storedBlock) }];
  await Promise.all([...primary, ...target].map(document => writeFile(path.join(root, document.file), document.content)));
  await Promise.all(canvases.map(canvas => atomicJson(path.join(root, 'canvases', `${canvas.id}.json`), canvas)));
  await atomicJson(path.join(root, 'workspaces.json'), [{ id: 'workspace', name: 'Native proofs',
    canvases: canvases.map(({ id, name }) => ({ id, name })) }]);
  const store = new CanvasStore(root); await store.init();
  const files = new JevWorkspaceFiles(root); await files.write('workspace', emptyJevWorkspace());
  const executor = new JevProposalExecutor(store, files);
  const sources = primary.map(document => sourceSnapshot('workspace', 'primary', document));
  const targetSources = target.map(document => sourceSnapshot('workspace', 'target', document));
  return { root, store, files, executor, primary, target, sources, targetSources };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function apply(current: Fixture, mutation: JevMutation, sources: JevSourceSnapshot[]) {
  const source = sources[0];
  const document = [...current.primary, ...current.target].find(document => document.id === source?.blockId);
  const quote = document?.content.split('\n')[0] ?? '';
  const evidence = source ? [{ source, start: 0, end: quote.length, quote }] : [];
  const proposal: JevProposal = { id: 'native-proposal', jobId: 'native-reviewed-job', action: 'file', title: 'Reviewed native organization',
    explanation: 'Preserve the exact source guards.', state: 'pending', createdAt: '2026-10-05T00:00:00Z', sources, evidence, mutation };
  const state = await current.files.read('workspace'); state.proposals.push(proposal); await current.files.write('workspace', state);
  return current.files.serial('workspace', () => current.executor.applyInside('workspace', proposal.id, owner)) as Promise<StoredJevReceipt>;
}

it('reads one postwrite canvas for 158 real sources while retaining ordered duplicate proofs and exact native reload', async () => {
  const current = await fixture(158);
  const sources = [...current.sources].reverse(); sources.push(sources[0]);
  const reads: string[] = []; const original = current.store.getCanvas.bind(current.store);
  current.store.getCanvas = (...args) => { reads.push(args[0]); return original(...args); };
  const receipt = await apply(current, { kind: 'document', canvasId: 'primary', blockId: current.primary[0].id,
    patch: { headline: 'Reviewed delivery requirement' } }, sources);
  // Two independent freshness checks, one planning read and one fresh postwrite read.
  // Before the patch this is 162 reads: 3 + 159 postwrite source reads.
  expect(reads).toEqual(['primary', 'primary', 'primary', 'primary']);
  const expected = sources.map(source => source.blockId === current.primary[0].id
    ? { ...source, metadataRevision: source.metadataRevision + 1 } : source);
  expect(receipt.sourcesAfter).toEqual(expected);
  const reloaded = new CanvasStore(current.root); const files = new JevWorkspaceFiles(current.root);
  const canonical = await reloaded.getCanvas('primary', true, false);
  const saved = canonical.blocks.find(document => document.id === current.primary[0].id)!;
  expect(saved).toMatchObject({ headline: 'Reviewed delivery requirement', tags: ['Manual tag'], x: 17, y: 29,
    incarnation: current.primary[0].incarnation, sourceGeneration: 1, metadataRevision: 2, jevOwnership: { pins: ['tags'] } });
  expect(canonical.blocks.map(document => document.content)).toEqual(current.primary.map(document => document.content));
  expect(receipt.sourcesAfter).toEqual(sources.map(source => sourceSnapshot('workspace', 'primary',
    canonical.blocks.find(document => document.id === source.blockId)!)));
  const ledger = await files.read('workspace'); expect(ledger.prepared).toEqual([]);
  expect(ledger.receipts.find(item => item.id === receipt.id)).toEqual(receipt);
  await writeFile(path.join(current.root, current.primary[157].file), '# A later external change');
  await expect(reloaded.jevExecutor.checkSources([current.sources[157]])).rejects.toMatchObject({ status: 409 });
});

it('preserves real receipt Undo and later manual corrections with fresh per-operation source proofs', async () => {
  const current = await fixture();
  const receipt = await apply(current, { kind: 'document', canvasId: 'primary', blockId: current.primary[0].id,
    patch: { headline: 'Reviewed delivery requirement' } }, current.sources);
  const restarted = new CanvasStore(current.root); const files = new JevWorkspaceFiles(current.root);
  const executor = new JevProposalExecutor(restarted, files);
  const undo = await files.serial('workspace', () => executor.undoInside('workspace', receipt.id, owner));
  expect(undo.state).toBe('applied');
  const restored = await new CanvasStore(current.root).getCanvasBlock('primary', current.primary[0].id);
  expect(restored.headline).toBeUndefined();
  expect(restored.jevOwnership).toMatchObject({ pins: ['tags'], removedLabels: [], removedLinks: [] });
  expect([...restored.jevOwnership!.managed].sort()).toEqual([...current.primary[0].jevOwnership!.managed].sort());
  expect(restored).toMatchObject({ content: current.primary[0].content, tags: ['Manual tag'], x: 17, y: 29, sourceGeneration: 1 });
  expect((await files.read('workspace')).receipts.find(item => item.id === receipt.id)?.state).toBe('undone');
  const refreshed = await restarted.getCanvas('primary', true, false);
  const nextSources = refreshed.blocks.map(document => sourceSnapshot('workspace', 'primary', document));
  const next = await restarted.jevExecutor.execute({ kind: 'document', canvasId: 'primary', blockId: restored.id,
    patch: { headline: 'A second checked heading' } }, nextSources, 'next-operation', owner.id, true,
  async plan => { await atomicJson(path.join(current.root, 'next-preparation.json'), plan); });
  expect(next.sourcesAfter[0]).toMatchObject({ metadataRevision: restored.metadataRevision! + 1 });
  await restarted.updateBlock('primary', restored.id, { headline: 'Later browser correction' }, owner.id);
  await expect(restarted.jevExecutor.checkSources(next.sourcesAfter)).rejects.toMatchObject({ status: 409 });
  expect((await new CanvasStore(current.root).getCanvasBlock('primary', restored.id)).headline).toBe('Later browser correction');
});

it('selects the destination per move source and shares each fresh canvas without reordering interleaved proofs', async () => {
  const current = await fixture(); const moved = current.primary[0];
  const sources = [current.targetSources[0], current.sources[0], current.sources[1], current.targetSources[1], current.sources[0]];
  const postReads: string[] = []; const original = current.store.getCanvas.bind(current.store);
  current.store.getCanvas = async (...args) => {
    const canvas = await original(...args);
    const movedPresent = canvas.blocks.some(document => document.id === moved.id);
    if ((canvas.id === 'primary' && !movedPresent) || (canvas.id === 'target' && movedPresent)) postReads.push(canvas.id);
    return canvas;
  };
  const receipt = await apply(current, { kind: 'move', canvasId: 'primary', blockId: moved.id, targetCanvasId: 'target' }, sources);
  expect(postReads.sort()).toEqual(['primary', 'target']);
  const restarted = new CanvasStore(current.root);
  const primary = await restarted.getCanvas('primary', true, false); const target = await restarted.getCanvas('target', true, false);
  const expected = sources.map(source => {
    const canvas = source.blockId === moved.id || source.canvasId === 'target' ? target : primary;
    return sourceSnapshot('workspace', canvas.id, canvas.blocks.find(document => document.id === source.blockId)!);
  });
  expect(receipt.sourcesAfter).toEqual(expected);
  expect(receipt.sourcesAfter.map(source => source.blockId)).toEqual(sources.map(source => source.blockId));
  expect((await new JevWorkspaceFiles(current.root).read('workspace')).receipts.find(item => item.id === receipt.id)?.sourcesAfter).toEqual(expected);
  expect(target.blocks.find(document => document.id === moved.id)).toMatchObject({ content: moved.content, tags: ['Manual tag'], incarnation: moved.incarnation });
  const files = new JevWorkspaceFiles(current.root);
  await files.serial('workspace', () => new JevProposalExecutor(restarted, files).undoInside('workspace', receipt.id, owner));
  expect((await new CanvasStore(current.root).getCanvasBlock('primary', moved.id)).content).toBe(moved.content);
});

it('keeps the first native duplicate block for postwrite proofs and uses a new canvas snapshot on the next execute', async () => {
  const current = await fixture(); const file = path.join(current.root, 'canvases', 'primary.json');
  const canvas = JSON.parse(await readFile(file, 'utf8'));
  canvas.blocks.push({ ...canvas.blocks[0], incarnation: 'later-duplicate', metadataRevision: 99 }); await atomicJson(file, canvas);
  const prepare = async (plan: unknown) => { await atomicJson(path.join(current.root, 'checked-preparation.json'), plan); };
  const task: Extract<JevMutation, { kind: 'task_create' }> = { kind: 'task_create', canvasId: 'primary', task: { id: 'first-work', title: 'Reviewed work', detail: 'Checked task evidence.' } };
  const first = await current.store.jevExecutor.execute(task, [current.sources[0], current.sources[0]], 'first-operation', owner.id, false, prepare);
  expect(first.sourcesAfter).toEqual([current.sources[0], current.sources[0]]);
  const updated = JSON.parse(await readFile(file, 'utf8')); updated.blocks[0].metadataRevision = 2; await atomicJson(file, updated);
  const fresh = { ...current.sources[0], metadataRevision: 2 };
  const second = await current.store.jevExecutor.execute({ ...task, task: { id: 'second-work', title: 'Second reviewed work', detail: 'Current metadata guard.' } },
    [fresh, fresh], 'second-operation', owner.id, false, prepare);
  expect(second.sourcesAfter).toEqual([fresh, fresh]);
  await expect(current.store.jevExecutor.checkSources(current.sources.slice(0, 1))).rejects.toMatchObject({ status: 409 });
});

it('does not load postwrite canvases for empty sources and preserves a native postwrite body failure', async () => {
  const current = await fixture(); const original = current.store.getCanvas.bind(current.store); let reads = 0;
  current.store.getCanvas = (...args) => { reads++; return original(...args); };
  const empty = await current.store.jevExecutor.execute({ kind: 'document', canvasId: 'primary', blockId: current.primary[0].id,
    patch: { headline: 'Reviewed heading' } }, [], 'empty-operation', owner.id, false,
  async plan => { await atomicJson(path.join(current.root, 'empty-preparation.json'), plan); });
  expect(empty.sourcesAfter).toEqual([]); expect(reads).toBe(1);
  const source = sourceSnapshot('workspace', 'primary', await new CanvasStore(current.root).getCanvasBlock('primary', current.primary[0].id));
  let prepared = false; let removed = false; reads = 0;
  current.store.getCanvas = async (...args) => {
    reads++;
    if (prepared && !removed) { removed = true; await rm(path.join(current.root, current.primary[0].file)); }
    return original(...args);
  };
  await expect(current.store.jevExecutor.execute({ kind: 'document', canvasId: 'primary', blockId: source.blockId,
    patch: { headline: 'A subsequent checked heading' } }, [source, source], 'failure-operation', owner.id, false,
  async plan => { await atomicJson(path.join(current.root, 'failure-preparation.json'), plan); prepared = true; })).rejects.toMatchObject({ code: 'ENOENT' });
  expect(reads).toBe(3);
  const metadata = JSON.parse(await readFile(path.join(current.root, 'canvases', 'primary.json'), 'utf8'));
  expect(metadata.blocks[0]).toMatchObject({ headline: 'A subsequent checked heading', metadataRevision: source.metadataRevision + 1, tags: ['Manual tag'] });
  await writeFile(path.join(current.root, current.primary[0].file), current.primary[0].content);
  const plan = JSON.parse(await readFile(path.join(current.root, 'failure-preparation.json'), 'utf8'));
  await new CanvasStore(current.root).jevExecutor.recover(plan.artifacts);
  expect((await new CanvasStore(current.root).getCanvasBlock('primary', source.blockId)).content).toBe(current.primary[0].content);
});
