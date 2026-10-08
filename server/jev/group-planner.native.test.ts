import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevPrincipal } from '../../shared/jev-types.js';
import type { JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';
import { evaluateJevAction } from './actions.js';

type ProviderState = { source?: { title: string; passages: Array<{ id: string; text: string }> };
  document?: { title: string; passages: Array<{ id: string; text: string }> }; groups?: Array<{ key: string; option: string }>;
  questionSets?: ProviderState[] };
const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let provider: Server; let root: string; let store: CanvasStore; let runtime: JevRuntime;
let workspaceId: string; let canvasId: string;
let selectiveGroupAssessment: boolean;

function answer(questionId: string, question: JevQuestion, input: ProviderState) {
  const batch = /^(\d+)__(.+)$/.exec(questionId);
  const state = batch ? input.questionSets![Number(batch[1])] : input;
  const id = batch?.[2] ?? questionId;
  if (question.type === 'noul') return { type: 'noul', noul: id === 'addressesAi' ? 0.01 : 0.99 };
  if (question.type === 'score') return { type: 'score', score: 0, confidence: 0.99,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), Number(index === 0)])) };
  const keys = Object.keys(question.criteria); const source = state.source ?? state.document;
  let choice = keys[0];
  if (['place', 'gate'].includes(id) && state.groups) choice = source?.title === 'Brand palette' ? 'none'
    : state.groups.find(group => group.key === 'custom:engineering')?.option ?? 'none';
  if (id === 'evidence') choice = source?.passages.find(passage => /engineering/i.test(passage.text))?.id ?? 'none';
  return { type: 'choice', choice, confidence: 0.99,
    probabilities: Object.fromEntries(keys.map(key => [key, Number(key === choice)])) };
}
beforeEach(async () => {
  selectiveGroupAssessment = false;
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const piece of request) raw += piece;
    const body = JSON.parse(raw) as { state: ProviderState; questions: Record<string, JevQuestion> };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions)
      .map(([id, question]) => [id, answer(id, question, body.state)])) }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Provider unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(path.join(tmpdir(), 'reflex-group-planner-')); store = new CanvasStore(root); await store.init();
  await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Grouping proof' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Engineering sources' })).id;
  runtime = new JevRuntime(store, { startTimer: false, evaluate: (context, request) => {
    context.apiKey = 'native-group-provider'; context.selectiveGroupAssessment = selectiveGroupAssessment;
    return evaluateJevAction(context, request);
  },
    fetcher: (_url, options) => fetch(origin, options) });
});
afterEach(async () => {
  runtime.close(); await runtime.idle(); provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve())); await rm(root, { recursive: true, force: true });
});
async function organize() {
  await runtime.run(workspaceId, { action: 'file', canvasId }, owner);
  await runtime.idle();
}

it.each([false, true])('files related documents durably and supports Undo without forcing unrelated sources (selective=%s)', async selective => {
  selectiveGroupAssessment = selective;
  const first = await store.createBlock(canvasId, { title: 'Service architecture', content: '# Engineering\n## API conventions\nEngineering services define reliable backend contracts.' });
  const second = await store.createBlock(canvasId, { title: 'Database design', content: '# Database design\nEngineering persistence is part of the backend architecture.' });
  const unrelated = await store.createBlock(canvasId, { title: 'Brand palette', content: '# Brand palette\nColors express our visual identity.' });
  await organize();
  const saved = await new CanvasStore(root).getCanvas(canvasId);
  expect(saved.blocks.find(block => block.id === first.id)?.group).toBe('custom:engineering');
  expect(saved.blocks.find(block => block.id === second.id)?.group).toBe('custom:engineering');
  expect(saved.blocks.find(block => block.id === unrelated.id)?.group).toBeUndefined();
  expect(saved.blocks.map(block => block.content)).toEqual([first.content, second.content, unrelated.content]);
  const state = await runtime.read(workspaceId, owner);
  expect(state.vocabulary.map(term => term.groupKey)).toEqual(['custom:engineering']);
  expect(state.jobs.filter(job => job.state === 'failed')).toEqual([]);
  const membership = state.receipts.find(receipt => receipt.after.kind === 'document' && receipt.after.blockId === second.id)!;
  expect(membership.automatic).toBe(true);
  await runtime.undo(workspaceId, membership.id, owner);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, second.id)).group).toBeUndefined();
  expect((await store.getCanvasBlock(canvasId, second.id)).content).toBe(second.content);
});

it.each([false, true])('consolidates a managed singleton subgroup through undoable placement and preserves an explicit group pin (selective=%s)', async selective => {
  selectiveGroupAssessment = selective;
  const source = await store.createBlock(canvasId, { title: 'Service guide', content: '# Engineering\n## Conventions\nEngineering describes service architecture.', group: 'custom:engineering/conventions' });
  const companion = await store.createBlock(canvasId, { title: 'Persistence guide', content: '# Persistence guide\nEngineering describes persistence architecture.' });
  const pinned = await store.createBlock(canvasId, { title: 'Pinned guide', content: '# Engineering\nEngineering describes frontend architecture.', group: 'custom:manual' });
  await runtime.setMetadata(workspaceId, canvasId, source.id, { managed: ['group'], pins: [] }, owner);
  await runtime.setMetadata(workspaceId, canvasId, pinned.id, { pins: ['group'] }, owner);
  const files = new JevWorkspaceFiles(root); const state = await files.read(workspaceId);
  state.vocabulary.push({ id: 'engineering', kind: 'group', name: 'Engineering', groupKey: 'custom:engineering', definition: 'Engineering architecture and implementation guidance.',
    aliases: [], state: 'active', version: 1, members: [{ canvasId, blockId: source.id }] },
  { id: 'engineering-conventions', parentId: 'engineering', kind: 'group', name: 'Engineering / Conventions', groupKey: 'custom:engineering/conventions',
    definition: 'The conventions section of the service guide.', aliases: [], state: 'active', version: 1, members: [{ canvasId, blockId: source.id }] });
  await files.write(workspaceId, state); await organize();
  expect((await store.getCanvasBlock(canvasId, source.id)).group).toBe('custom:engineering');
  expect((await store.getCanvasBlock(canvasId, companion.id)).group).toBe('custom:engineering');
  expect((await store.getCanvasBlock(canvasId, pinned.id)).group).toBe('custom:manual');
  const checked = await runtime.read(workspaceId, owner);
  expect(checked.vocabulary).toHaveLength(2);
  const receipt = checked.receipts.find(item => item.after.kind === 'document' && item.after.blockId === source.id && item.after.patch.group === 'custom:engineering')!;
  expect(receipt.after).toMatchObject({ patch: { group: 'custom:engineering' } });
  await runtime.undo(workspaceId, receipt.id, owner);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).group).toBe('custom:engineering/conventions');
  expect((await store.getCanvasBlock(canvasId, source.id)).content).toBe(source.content);
});
