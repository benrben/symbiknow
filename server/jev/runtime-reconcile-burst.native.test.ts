import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { JevPrincipal } from '../../shared/jev-types.js';
import { type JevAnswer, type JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let runtime: JevRuntime; let provider: Server; let release: (() => void) | undefined;

function unsupported(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: 0.01 };
  const keys = question.type === 'score' ? question.criteria.map((_, index) => String(index)) : Object.keys(question.criteria);
  const selected = question.type === 'choice' && 'none' in question.criteria ? 'none' : keys[0];
  const probabilities = Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0]));
  return question.type === 'choice' ? { type: 'choice', choice: selected, confidence: 0.99, probabilities }
    : { type: 'score', score: 0, confidence: 0.99, probabilities };
}
afterEach(async () => {
  release?.(); await runtime?.shutdown();
  provider?.closeAllConnections();
  if (provider) await new Promise<void>(resolve => provider.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('reconciles a native source burst in two scans and processes every final source revision without losing manual metadata', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  let decisions = 0;
  provider = createServer(async (request, response) => {
    let input = ''; for await (const chunk of request) input += String(chunk);
    const body = JSON.parse(input) as { questions: Record<string, JevQuestion> }; decisions += 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, unsupported(question)])) }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native burst provider did not listen');
  const origin = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(path.join(tmpdir(), 'jev-native-source-burst-'));
  const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  const workspaceId = (await store.createWorkspace({ name: 'Native burst' })).id;
  const canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas sources' })).id;
  runtime = new JevRuntime(store, { startTimer: false, apiKey: 'local-burst-provider', fetcher: (_url, options) => fetch(origin, options) });
  await runtime.idle();
  let entered!: () => void;
  const firstScan = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let scans = 0; const sourceCounts: number[] = [];
  const reconcile = runtime.reconcile.bind(runtime);
  runtime.reconcile = async (...args) => {
    await reconcile(...args);
    if (args[0] !== workspaceId) return;
    scans += 1; sourceCounts.push((await store.getCanvasSummary(canvasId)).blocks.length);
    if (scans === 1) { entered(); await held; }
  };
  const first = await store.createBlock(canvasId, { title: 'Atlas first', content: '# Atlas first\nAtlas rollout first requirements.' }, 'Browser');
  await firstScan;
  const second = await store.createBlock(canvasId, { title: 'Atlas second', content: '# Atlas second\nAtlas rollout second requirements.' }, 'Browser');
  await store.updateBlock(canvasId, first.id, { content: '# Atlas first revised\nAtlas rollout first corrected requirements.' }, 'Browser');
  await store.updateBlock(canvasId, second.id, { tags: ['manual-approved'] }, 'Browser');
  await store.updateBlock(canvasId, first.id, { content: '# Atlas first final\nAtlas rollout first final corrected requirements.' }, 'Browser');
  expect(scans).toBe(1);
  release!(); await runtime.idle();
  expect(scans).toBe(2); expect(sourceCounts).toEqual([1, 2]);
  const canonical = await new CanvasStore(root).getCanvas(canvasId, true, false);
  expect(canonical.blocks.map(block => block.id)).toEqual([first.id, second.id]);
  expect(canonical.blocks[0].content).toBe('# Atlas first final\nAtlas rollout first final corrected requirements.');
  expect(canonical.blocks[1].content).toBe(second.content);
  expect(canonical.blocks[1].tags).toEqual(['manual-approved']);
  expect(canonical.blocks[1].jevOwnership?.pins).toContain('tags');
  const state = await runtime.read(workspaceId, owner);
  for (const block of canonical.blocks) {
    expect(state.profiles[`${canvasId}:${block.id}`]?.source).toMatchObject({
      blockId: block.id, incarnation: block.incarnation, sourceGeneration: block.sourceGeneration, contentHash: block.contentHash });
    expect(state.jobs.some(job => job.request.action === 'profile' && job.state === 'completed'
      && job.sources.some(source => source.blockId === block.id && source.contentHash === block.contentHash))).toBe(true);
  }
  expect(state.jobs.filter(job => ['queued', 'running'].includes(job.state))).toEqual([]);
  expect(decisions).toBeGreaterThan(2);
});
