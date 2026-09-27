import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { applyWorkspaceRun, previewWorkspaceRun, undoWorkspaceRun } from './runs.js';
import type { JevDecider } from './jev.js';

const directories: string[] = [];
async function freshStore() {
  const directory = await mkdtemp(path.join(tmpdir(), 'symbiknow-runs-'));
  directories.push(directory);
  const store = new CanvasStore(directory);
  await store.init();
  await store.updateSettings({ jevApiKey: 'test-jev' });
  return store;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const decider: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
  question.type === 'choice' ? { type: 'choice', choice: 'guide', confidence: 0.95,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === 'guide')])) }
    : question.type === 'noul' ? { type: 'noul', noul: 0.1 }
      : { type: 'score', score: 2, confidence: 0.9, probabilities: { '0': 0, '1': 0, '2': 1, '3': 0, '4': 0 } },
]));

function tidyDecider(seen: string[] = []): JevDecider {
  return async (_key, state, questions) => {
    const doc = (state as { document?: { kind: string; purpose?: string; workArea?: string } }).document;
    if (questions.d0_purpose) {
      seen.push('purpose');
      expect(doc?.kind).toBe('slides');
    }
    if (questions.d0_domain) {
      seen.push('work_area');
      expect(doc?.purpose).toBe('plan');
    }
    if (questions.d0_order) {
      seen.push('layout');
      expect(doc?.workArea).toBe('engineering/backend');
    }
    return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: 0.1 }];
      if (question.type === 'score') return [id, { type: 'score', score: 4, confidence: 0.96,
        probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } }];
      const preferred = id.endsWith('_purpose') ? 'plan' : id.endsWith('_domain') ? 'engineering'
        : id.endsWith('_work_area') ? 'backend' : Object.keys(question.criteria)[0];
      return [id, { type: 'choice', choice: preferred,
        confidence: id.endsWith('_purpose') ? 0.91 : id.endsWith('_work_area') ? 0.93 : 0.95,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === preferred)])) }];
    }));
  };
}

it('previews without writes, applies selected changes, then undoes them', async () => {
  const store = await freshStore();
  const before = await store.getCanvas('product-roadmap');
  const preview = await previewWorkspaceRun(store, 'acme-team', 'purpose', decider);
  expect(preview.dryRun).toBe(true);
  expect(preview.changes.length).toBeGreaterThan(0);
  expect(await store.getCanvas('product-roadmap')).toEqual(before);

  const selected = preview.changes.slice(0, 1).map(change => change.id);
  const applied = await applyWorkspaceRun(store, preview.runId, selected);
  expect(applied.applied).toEqual(selected);
  expect((await store.getCanvas('product-roadmap')).blocks.some(block => block.purpose === 'guide')).toBe(true);

  const undone = await undoWorkspaceRun(store, preview.runId);
  expect(undone.reverted).toEqual(selected);
  expect(await store.getCanvas('product-roadmap')).toEqual(before);
});

it('skips a selected change when its source document changed after preview', async () => {
  const store = await freshStore();
  const preview = await previewWorkspaceRun(store, 'acme-team', 'purpose', decider);
  const selected = preview.changes[0];
  if (selected.action.type !== 'update') throw new Error('Expected purpose update');
  await store.updateBlock(selected.canvasId, selected.action.blockId, { content: '# Edited after preview' });
  const applied = await applyWorkspaceRun(store, preview.runId, [selected.id]);
  expect(applied.applied).toEqual([]);
  expect(applied.skipped).toEqual([{ id: selected.id, reason: 'Document changed since preview' }]);
});

it('binds a preview to its workspace and does not undo a later edit', async () => {
  const store = await freshStore();
  const other = await store.createWorkspace({ name: 'Other' });
  const preview = await previewWorkspaceRun(store, 'acme-team', 'purpose', decider);
  const selected = preview.changes[0];
  await expect(applyWorkspaceRun(store, preview.runId, [selected.id], 'Jev', other.id))
    .rejects.toMatchObject({ status: 400 });
  expect((await applyWorkspaceRun(store, preview.runId, [selected.id], 'Jev', 'acme-team')).applied).toEqual([selected.id]);
  if (selected.action.type !== 'update') throw new Error('Expected purpose update');
  await store.updateBlock(selected.canvasId, selected.action.blockId, { purpose: 'reference' });
  const undo = await undoWorkspaceRun(store, preview.runId);
  expect(undo.reverted).toEqual([]);
  expect(undo.skipped).toEqual([{ id: selected.id, reason: 'Current state differs from the applied change' }]);
});

it('chains loader, labels, and layout through an in-memory canvas with minimum confidence', async () => {
  const store = await freshStore();
  await store.updateBlock('product-roadmap', 'roadmap-overview', {
    content: '---\nmarp: true\n---\n# Roadmap\n---\n# Milestones',
  });
  const before = await store.getCanvas('product-roadmap');
  const seen: string[] = [];
  const preview = await previewWorkspaceRun(store, 'acme-team', 'tidy', tidyDecider(seen));
  expect(seen).toEqual(['purpose', 'work_area', 'layout']);
  expect(await store.getCanvas('product-roadmap')).toEqual(before);
  const loader = preview.changes.find(change => change.action.type === 'update'
    && change.action.blockId === 'roadmap-overview' && change.action.patch.kind === 'slides');
  const purpose = preview.changes.find(change => change.action.type === 'update'
    && change.action.blockId === 'roadmap-overview' && change.action.patch.purpose === 'plan');
  const area = preview.changes.find(change => change.action.type === 'update'
    && change.action.blockId === 'roadmap-overview' && change.action.patch.workArea === 'engineering/backend');
  const layout = preview.changes.find(change => change.action.type === 'layout');
  expect(loader).toMatchObject({ confidence: 1 });
  expect(purpose).toMatchObject({ confidence: 0.91, dependsOn: [loader?.id] });
  expect(area).toMatchObject({ confidence: 0.91, dependsOn: [loader?.id, purpose?.id] });
  expect(layout?.confidence).toBe(0.91);
  expect(layout?.dependsOn).toEqual(expect.arrayContaining([loader?.id, purpose?.id, area?.id]));
  const layoutOnly = await applyWorkspaceRun(store, preview.runId, [layout!.id]);
  expect(layoutOnly.applied).toEqual([]);
  expect(layoutOnly.skipped).toEqual([{ id: layout!.id, reason: 'Prerequisite action was not applied' }]);
  expect(await store.getCanvas('product-roadmap')).toEqual(before);
}, 20_000);

it('applies a selected tidy chain and undoes its steps in reverse order', async () => {
  const store = await freshStore();
  await store.updateBlock('product-roadmap', 'roadmap-overview', {
    content: '---\nmarp: true\n---\n# Roadmap\n---\n# Milestones',
  });
  const before = await store.getCanvas('product-roadmap');
  const preview = await previewWorkspaceRun(store, 'acme-team', 'tidy', tidyDecider());
  const selected = preview.changes.map(change => change.id);
  const applied = await applyWorkspaceRun(store, preview.runId, selected);
  expect(applied.applied).toEqual(selected);
  expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'roadmap-overview'))
    .toMatchObject({ kind: 'slides', purpose: 'plan', workArea: 'engineering/backend' });
  const undone = await undoWorkspaceRun(store, preview.runId);
  expect(undone.reverted).toEqual([...selected].reverse());
  expect(undone.skipped).toEqual([]);
  expect(await store.getCanvas('product-roadmap')).toEqual(before);
}, 20_000);

it('stops a tidy chain at a review-only label suggestion', async () => {
  const store = await freshStore();
  await store.updateBlock('product-roadmap', 'roadmap-overview', {
    content: '---\nmarp: true\n---\n# Roadmap\n---\n# Milestones',
  });
  const low: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'score') return [id, { type: 'score', score: 4, confidence: 0.96,
      probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } }];
    if (question.type === 'noul') return [id, { type: 'noul', noul: 0.1 }];
    const preferred = id.endsWith('_purpose') ? 'plan' : id.endsWith('_domain') ? 'engineering'
      : id.endsWith('_work_area') ? 'backend' : Object.keys(question.criteria)[0];
    return [id, { type: 'choice', choice: preferred, confidence: id === 'd0_purpose' ? 0.7 : 0.95,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === preferred)])) }];
  }));
  const preview = await previewWorkspaceRun(store, 'acme-team', 'tidy', low);
  expect(preview.suggestions).toEqual(expect.arrayContaining([
    expect.objectContaining({ canvasId: 'product-roadmap', item: expect.objectContaining({
      category: 'purpose', blockIds: ['roadmap-overview'], confidence: 0.7,
    }) }),
  ]));
  expect(preview.changes.some(change => change.action.type === 'layout')).toBe(false);
  expect(preview.changes.some(change => change.action.type === 'update'
    && change.action.blockId === 'roadmap-overview' && change.action.patch.workArea)).toBe(false);
}, 20_000);

it('previews within-canvas links before cross-canvas links and carries their confidence', async () => {
  const store = await freshStore();
  const original = await store.getCanvas('product-roadmap');
  const second = await store.createCanvas('acme-team', { name: 'Launch copy' });
  await store.createBlock(second.id, { title: 'Roadmap copy', content: original.blocks[0].content });
  const beforeSecond = await store.getCanvas(second.id);
  const stages: string[] = [];
  const linkDecider: JevDecider = async (_key, _state, questions) => {
    if (Object.keys(questions).some(id => /^p\d+_link/.test(id))) stages.push('within');
    if (Object.keys(questions).some(id => /^c\d+_related/.test(id))) stages.push('canvases');
    if (Object.keys(questions).some(id => /^x\d+_strength/.test(id))) stages.push('across');
    return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'score') return [id, { type: 'score', score: 4, confidence: 0.95,
        probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } }];
      if (question.type === 'noul') return [id, { type: 'noul', noul: 1 }];
      const preferred = id.endsWith('_link') || id.endsWith('_direction') ? 'a_to_b'
        : id.endsWith('_relation') ? (id.startsWith('x') ? 'same_topic' : 'related') : Object.keys(question.criteria)[0];
      const confidence = id.endsWith('_link') ? 0.88 : 0.95;
      return [id, { type: 'choice', choice: preferred, confidence,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === preferred)])) }];
    }));
  };
  const preview = await previewWorkspaceRun(store, 'acme-team', 'connect_all', linkDecider);
  expect(stages.indexOf('within')).toBeGreaterThanOrEqual(0);
  expect(stages.indexOf('canvases')).toBeGreaterThan(stages.lastIndexOf('within'));
  expect(stages.indexOf('across')).toBeGreaterThan(stages.indexOf('canvases'));
  const cross = preview.changes.filter(change => change.action.type === 'cross_link');
  expect(cross.length).toBeGreaterThan(0);
  expect(preview.changes.findIndex(change => change.action.type === 'cross_link'))
    .toBeGreaterThan(preview.changes.map(change => change.action.type).lastIndexOf('link'));
  expect(cross.some(change => change.confidence === 0.88 && change.dependsOn?.length)).toBe(true);
  const dependent = cross.find(change => change.dependsOn?.length)!;
  const crossOnly = await applyWorkspaceRun(store, preview.runId, [dependent.id]);
  expect(crossOnly.applied).toEqual([]);
  expect(crossOnly.skipped).toEqual([{ id: dependent.id, reason: 'Prerequisite action was not applied' }]);
  expect(await store.getCanvas('product-roadmap')).toEqual(original);
  expect(await store.getCanvas(second.id)).toEqual(beforeSecond);
}, 20_000);

it('marks dedupe plans for reviewed merge and a later connection rerun', async () => {
  const store = await freshStore();
  const original = await store.getCanvas('product-roadmap');
  await store.createBlock('product-roadmap', { title: 'Roadmap copy', content: original.blocks[0].content });
  const before = await store.getCanvas('product-roadmap');
  const duplicateDecider: JevDecider = async (_key, _state, questions) => Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (question.type === 'score') return [id, { type: 'score', score: 4, confidence: 0.95,
        probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } }];
      if (question.type === 'noul') return [id, { type: 'noul', noul: 0.95 }];
      const preferred = id.endsWith('_dup_kind') ? 'identical' : id.endsWith('_newer') ? 'unclear'
        : Object.keys(question.criteria)[0];
      return [id, { type: 'choice', choice: preferred, confidence: 0.95,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === preferred)])) }];
    }));
  const preview = await previewWorkspaceRun(store, 'acme-team', 'dedupe', duplicateDecider);
  const merge = preview.changes.find(change => change.action.type === 'merge');
  expect(merge).toMatchObject({ requiresClick: true,
    postMerge: { kind: 'connection', canvasId: 'product-roadmap', blockIds: [expect.any(String)] } });
  expect(await store.getCanvas('product-roadmap')).toEqual(before);
  const applied = await applyWorkspaceRun(store, preview.runId, [merge!.id]);
  expect(applied.applied).toEqual([]);
  expect(applied.skipped?.[0].reason).toContain('reviewed content');
  expect(await store.getCanvas('product-roadmap')).toEqual(before);
}, 20_000);
