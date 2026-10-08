import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AskSymbiResult, SymbiCoverage, SymbiPassage, SymbiReflexResult } from '../shared/symbi-contract.js';
import type { CanvasDocument } from '../shared/types.js';
import type { RouteContext } from './api-context.js';
import { sendJson } from './api-http.js';
import { symbiRoutes } from './api-symbi.js';
import { ApiError } from './errors.js';
import { getJevRuntime } from './jev/runtime.js';
import { CanvasStore } from './storage.js';
import { SymbiJudgmentCache } from './symbi-judgment-cache.js';

/** Deletes one document just after its passage was verified, as a concurrent editor would. */
class RacingStore extends CanvasStore {
  pendingDeletion?: { canvasId: string; blockId: string };
  override async getCanvasSummary(id: string): Promise<CanvasDocument> {
    const target = this.pendingDeletion;
    this.pendingDeletion = undefined;
    if (target) await this.deleteBlock(target.canvasId, target.blockId);
    return super.getCanvasSummary(id);
  }
}

type ProviderRequest = { state: { question?: string; claim?: string; documents: Array<{ title: string }> };
  questions: Record<string, { criteria: Record<string, string> }> };
type Fixture = Awaited<ReturnType<typeof fixture>>;
const ready: SymbiCoverage = { status: 'ready', checkedDocuments: 2, eligibleDocuments: 2, pendingDocuments: 0 };
const servers: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.stubEnv('TYPESAFE_API_KEY', ''); });
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
});

/** Picks the first listed document for a search and "yes" for a claim, recording every provider request. */
function offlineProvider(requests: ProviderRequest[]) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as ProviderRequest;
    requests.push(request);
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const keys = Object.keys(question.criteria);
      const picked = keys.includes('yes') ? 'yes' : keys[0];
      return [id, { type: 'choice', choice: picked, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, Number(key === picked)])) }];
    }));
    return Response.json({ answers, usage: { input_tokens: 10, output_tokens: 2 } });
  }) as unknown as typeof fetch;
}

/** `crossWorkspace` puts the health check in a second workspace, so one search spans two provider policies. */
async function fixture(requests: ProviderRequest[] = [], options: { crossWorkspace?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-brain-route-'));
  const store = new RacingStore(root); await store.init();
  const provider = offlineProvider(requests);
  const runtime = getJevRuntime(store, { fetcher: provider });
  cleanups.push(async () => { await runtime.shutdown(); await store.updateSettings({}); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const workspaceId = (await store.listWorkspaces())[0].id;
  const canvas = await store.createCanvas(workspaceId, { name: 'Release operations' });
  const other = await store.createCanvas(workspaceId, { name: 'Private research' });
  const healthWorkspaceId = options.crossWorkspace ? (await store.createWorkspace({ name: 'Site reliability' })).id : workspaceId;
  const healthCanvas = options.crossWorkspace ? await store.createCanvas(healthWorkspaceId, { name: 'Service checks' }) : canvas;
  const rollback = await store.createBlock(canvas.id, { title: 'Rollback procedure',
    content: '# Rollback procedure\n\n## Restore\n\nTo undo a failed release, restore the previous deployment.' });
  const health = await store.createBlock(healthCanvas.id, { title: 'Health check',
    content: '# Health check\n\n## Verify\n\nAfter a rollback, verify service health before reopening traffic.' });
  for (const id of new Set([workspaceId, healthWorkspaceId])) await runtime.configure(id, { paused: true, externalProcessing: true },
    { id: 'fixture-owner', kind: 'user', access: 'write', canConfigure: true });
  await store.updateSettings({ secrets: { TYPESAFE_API_KEY: 'offline-fixture-key' } });
  const { token } = await store.createMcpToken('Scoped searcher', 'read', { allowedCanvasIds: [...new Set([canvas.id, healthCanvas.id])] });
  const passage = (block: typeof rollback, canvasId: string, excerpt: string): SymbiPassage => ({ canvasId, blockId: block.id,
    contentHash: block.contentHash!, startOffset: block.content.indexOf(excerpt), endOffset: block.content.indexOf(excerpt) + excerpt.length, excerpt });
  const passages = [passage(rollback, canvas.id, 'restore the previous deployment'), passage(health, healthCanvas.id, 'verify service health')];
  const route = { judgments: await SymbiJudgmentCache.open(root) };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const context: RouteContext = { store, request, response, method: request.method ?? 'GET', route: url.pathname, url,
      actor: 'Fixture reader', signal: new AbortController().signal, fetcher: provider, symbiJudgments: route.judgments,
      symbiIndex: { expectedDocumentIds: async () => [rollback.id, health.id],
        search: async () => ({ version: 1, passages, coverage: ready }) } as unknown as RouteContext['symbiIndex'] };
    void symbiRoutes(context).then(handled => { if (!handled) sendJson(response, 404, { error: 'Not found' }); })
      .catch(error => sendJson(response, error instanceof ApiError ? error.status : 500, { error: String(error) }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const { port } = address;
  async function post<T>(pathname: string, body: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() as T };
  }
  return { root, store, canvas, other, healthCanvas, rollback, health, provider, route, post };
}

/** Rewrites the durable judgment file, then reopens it as a restarted server would. */
async function damageStoredJudgment(f: Fixture, damage: (answers: Record<string, Record<string, unknown>>) => void) {
  const file = path.join(f.root, 'symbi-judgments.json');
  const entries = JSON.parse(await readFile(file, 'utf8')) as Array<{ value: { answers: Record<string, Record<string, unknown>> } }>;
  damage(entries[0].value.answers);
  await writeFile(file, JSON.stringify(entries));
  f.route.judgments = await SymbiJudgmentCache.open(f.root);
}

it('rejects a malformed claim check and a related lookup outside the token canvas scope', async () => {
  const f = await fixture();
  expect(await f.post('/api/symbi/reflex', { claim: '' })).toMatchObject({ status: 400, value: { error: expect.stringContaining('Invalid symbi_reflex request') } });
  expect(await f.post('/api/symbi/related', { canvasId: f.other.id, blockId: f.rollback.id })).toMatchObject({ status: 404 });
  expect(f.provider).not.toHaveBeenCalled();
});

it('names a document deleted during a search by its ID when it is judged and listed', async () => {
  const requests: ProviderRequest[] = [];
  const f = await fixture(requests);
  f.store.pendingDeletion = { canvasId: f.canvas.id, blockId: f.rollback.id };
  const answer = await f.post<AskSymbiResult>('/api/symbi/ask', { question: 'How do I undo a failed release?', mode: 'combined', canvasId: f.canvas.id });
  expect(answer.status).toBe(200);
  expect(requests[0].state.documents.map(document => document.title)).toEqual([f.rollback.id, 'Health check']);
  expect(answer.value.matches).toEqual([expect.objectContaining({ blockId: f.rollback.id, title: f.rollback.id })]);
});

it('names a document deleted during a claim check by its ID in the judged evidence', async () => {
  const requests: ProviderRequest[] = [];
  const f = await fixture(requests);
  f.store.pendingDeletion = { canvasId: f.canvas.id, blockId: f.health.id };
  const answer = await f.post<SymbiReflexResult>('/api/symbi/reflex', { claim: 'Operators verify service health after a rollback', canvasId: f.canvas.id });
  expect(answer).toMatchObject({ status: 200, value: { verdict: 'yes', providerUsage: { requests: 1 } } });
  expect(requests[0].state.documents.map(document => document.title)).toEqual(['Rollback procedure', f.health.id]);
});

it('never turns a damaged stored search judgment into a confident match', async () => {
  const f = await fixture();
  const question = { question: 'How do I undo a failed release?', mode: 'combined', canvasId: f.canvas.id };
  const titles = async () => (await f.post<AskSymbiResult>('/api/symbi/ask', question)).value.matches.map(match => match.title);
  expect(await titles()).toEqual(['Rollback procedure']);
  await damageStoredJudgment(f, answers => { answers.rank.probabilities = { B: .9, none: .1 }; });
  expect(await titles()).toEqual(['Health check']);
  await damageStoredJudgment(f, answers => { answers.gate.probabilities = { A: .9, B: .1 }; });
  expect(await titles()).toEqual([]);
  await damageStoredJudgment(f, answers => { answers.rank = { type: 'noul', noul: .9 }; });
  expect(await titles()).toEqual([]);
  expect(f.provider).toHaveBeenCalledTimes(1);
});

it('judges one search across two workspaces once, with both workspace policies allowing provider use', async () => {
  const requests: ProviderRequest[] = [];
  const f = await fixture(requests, { crossWorkspace: true });
  const question = { question: 'How do I undo a failed release and check health?', mode: 'combined' };
  const first = await f.post<AskSymbiResult>('/api/symbi/ask', question);
  expect(first.status).toBe(200);
  expect(requests[0].state.documents.map(document => document.title)).toEqual(['Rollback procedure', 'Health check']);
  expect(first.value.matches).toEqual([expect.objectContaining({ blockId: f.rollback.id, canvasId: f.canvas.id })]);
  expect((await f.post<AskSymbiResult>('/api/symbi/ask', question)).value.matches).toEqual(first.value.matches);
  expect(f.provider).toHaveBeenCalledTimes(1);
});
