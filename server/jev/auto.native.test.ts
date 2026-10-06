import { mkdtemp,rm } from 'node:fs/promises';
import { createServer,type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,expect,it } from 'vitest';
import type { JevPrincipal } from '../../shared/jev-types.js';
import type { JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { evaluateJevAction } from './actions.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let provider: Server;
let root: string;
let store: CanvasStore;
let runtime: JevRuntime;
let workspaceId: string;
let canvasId: string;
let certainty: number;

function answer(id: string, question: JevQuestion) {
  if (question.type === 'noul') return { type: 'noul', noul: id === 'addressesAi' ? 0.02 : certainty };
  if (question.type === 'score') return { type: 'score', score: 0, confidence: certainty,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 0 ? 1 : 0])) };
  const keys = Object.keys(question.criteria);
  const descriptions = question.criteria as Record<string, string>;
  const selected = id === 'group' ? keys.find(key => descriptions[key].startsWith('Atlas / Rollout (')) ?? keys[0] : keys[0];
  return { type: 'choice', choice: selected, confidence: certainty,
    probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0])) };
}

beforeEach(async () => {
   certainty = 0.99;
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const piece of request) raw += piece;
    const body = JSON.parse(raw) as { questions: Record<string, JevQuestion> };
    
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(id, question)])) }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Provider unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(path.join(tmpdir(), 'reflex-auto-native-'));
  store = new CanvasStore(root); await store.init();
  await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Automatic workspace' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Existing canvas' })).id;
  runtime = new JevRuntime(store, { startTimer: false, evaluate: (context, request) => {
    context.apiKey = 'native-provider'; return evaluateJevAction(context, request);
  },
    fetcher: (url, options) => fetch(`${origin}${new URL(String(url)).pathname}`, options) });
});
afterEach(async () => {
  runtime.close(); await runtime.idle(); provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

it('keeps manual group pins while automatically reusing supported native groups without a second confidence threshold', async () => {
  const pinned = await store.createBlock(canvasId, { title: 'Pinned Atlas', content: '# Atlas\n## Rollout\nAtlas delivery process.', group: 'custom:manual' });
  const uncertain = await store.createBlock(canvasId, { title: 'Uncertain Atlas', content: '# Atlas\n## Rollout\nAtlas delivery process.' });
  certainty = 0.8;
  await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [pinned.id, uncertain.id] }, owner);
  await runtime.idle();
  expect((await store.getCanvasBlock(canvasId, pinned.id)).group).toBe('custom:manual');
  expect((await store.getCanvasBlock(canvasId, uncertain.id)).group).toBe('custom:manual');
  const state = await runtime.read(workspaceId, owner);
  expect(state.vocabulary).toEqual([]);
  expect(state.proposals.some(proposal => proposal.state === 'applied' && proposal.decisionConfidences?.includes(0.8))).toBe(true);
});
