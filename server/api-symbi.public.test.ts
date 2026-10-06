import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AskSymbiResult, SymbiCoverage, SymbiPassage, SymbiReflexResult } from '../shared/symbi-contract.js';
import type { RouteContext } from './api-context.js';
import { sendJson } from './api-http.js';
import { symbiRoutes } from './api-symbi.js';
import { ApiError } from './errors.js';
import { createApiServer } from './index.js';
import { choice, decideWithJev } from './jev.js';
import { CanvasStore } from './storage.js';
import { SymbiJudgmentCache } from './symbi-judgment-cache.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function fixture(providerOverride?: typeof fetch) {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-brain-api-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  const canvas = await store.createCanvas((await store.listWorkspaces())[0].id, { name: 'Release operations' });
  const source = await store.createBlock(canvas.id, { title: 'Rollback procedure',
    content: '# Rollback procedure\nTo undo a failed release, restore the previous deployment and verify service health.' });
  const other = await store.createCanvas((await store.listWorkspaces())[0].id, { name: 'Private research' });
  await store.createBlock(other.id, { title: 'Private research', content: '# Internal experiment\nHidden from the scoped reader.' });
  const { token } = await store.createMcpToken('Scoped searcher', 'read', { allowedCanvasIds: [canvas.id] });
  vi.stubEnv('SYMBI_MODEL_ROOT', '/private/tmp/symbi-models');
  const provider = providerOverride ?? vi.fn(async () => { throw new Error('Semantic search called a provider'); }) as unknown as typeof fetch;
  const server = await createApiServer({ dataDir: root, fetcher: provider });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  async function post<T>(route: string, body: unknown) {
    const response = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() as T };
  }
  return { root, store, canvas, source, other, provider, post, base, token };
}

async function controlledIndexRoute(f: Awaited<ReturnType<typeof fixture>>, passages: SymbiPassage[],
  coverage: SymbiCoverage, options: { index?: boolean; judgments?: boolean; token?: string;
    onSearch?: (request: unknown) => void; judgmentOverride?: unknown } = {}) {
  const symbiJudgments = options.judgments === false ? undefined : options.judgmentOverride
    ? { getOrRun: async () => options.judgmentOverride } as unknown as RouteContext['symbiJudgments']
    : await SymbiJudgmentCache.open(f.root);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const context: RouteContext = { store: f.store, request, response, method: request.method ?? 'GET', route: url.pathname,
      url, actor: 'Fixture reader', signal: new AbortController().signal, fetcher: f.provider, symbiJudgments,
      symbiIndex: options.index === false ? undefined : {
        expectedDocumentIds: async () => [f.source.id],
        search: async (searchRequest: unknown) => { options.onSearch?.(searchRequest); return { version: 1, passages, coverage }; },
      } as unknown as RouteContext['symbiIndex'] };
    void symbiRoutes(context).then(handled => { if (!handled) sendJson(response, 404, { error: 'Not found' }); })
      .catch(error => sendJson(response, error instanceof ApiError ? error.status : 500,
        { error: error instanceof Error ? error.message : String(error) }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No controlled route port');
  const base = `http://127.0.0.1:${address.port}`;
  return async <T>(route: string, body: unknown) => {
    const response = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${options.token ?? f.token}`,
      'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() as T };
  };
}

async function readySource(f: Awaited<ReturnType<typeof fixture>>) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await f.post<AskSymbiResult>('/api/symbi/ask', { question: 'rollback procedure', mode: 'semantic',
      canvasId: f.canvas.id, documentIds: [f.source.id] });
    if (result.value.coverage.status === 'ready' && result.value.matches.length) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Local source did not become searchable');
}

it('finds an exact local source offline, reports coverage and never sends semantic evidence to a provider', async () => {
  const f = await fixture();
  const sourceFile = path.join(f.root, f.source.file);
  const before = await readFile(sourceFile, 'utf8');
  let answer: AskSymbiResult | undefined;
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await f.post<AskSymbiResult>('/api/symbi/ask', { question: 'failed release rollback procedure', mode: 'semantic',
      canvasId: f.canvas.id, limit: 5, navigate: true });
    expect(result.status).toBe(200);
    answer = result.value;
    if (answer.coverage.status === 'ready' && answer.matches.length) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  expect(answer?.matches[0]).toMatchObject({ canvasId: f.canvas.id, blockId: f.source.id,
    passages: [expect.objectContaining({ contentHash: f.source.contentHash })] });
  expect(answer?.navigation).toMatchObject({ canvasId: f.canvas.id, activated: false });
  expect(answer?.navigation?.href).toContain(`?canvas=${f.canvas.id}`);
  expect(answer?.matches.every(match => match.canvasId !== f.other.id)).toBe(true);
  expect(answer?.providerUsage.requests).toBe(0);
  expect(f.provider).not.toHaveBeenCalled();
  expect(await readFile(sourceFile, 'utf8')).toBe(before);
}, 30000);

it('checks a claim once and reuses the scoped, source-versioned judgment on retry', async () => {
  let claimCalls = 0;
  let askCalls = 0;
  const provider = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state?: { claim?: string; question?: string } };
    if (request.state?.claim) claimCalls++;
    if (request.state?.question) askCalls++;
    const answers = Object.fromEntries(Object.keys(request.questions).map(id => [id, {
      type: 'choice', choice: 'yes', probabilities: { yes: 1, no: 0, insufficient_evidence: 0 }, confidence: 1,
    }]));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 140, output_tokens: 20 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const f = await fixture(provider as unknown as typeof fetch);
  const put = (route: string, body: unknown) => fetch(f.base + route, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await put('/api/settings', { secrets: { TYPESAFE_API_KEY: 'offline-fixture-key' } })).status).toBe(200);
  expect((await put(`/api/canvases/${f.canvas.id}/jev/settings`, { externalProcessing: true })).status).toBe(200);
  for (let attempt = 0; attempt < 80; attempt++) {
    const ready = await f.post<AskSymbiResult>('/api/symbi/ask', { question: 'restore previous deployment',
      mode: 'semantic', canvasId: f.canvas.id });
    if (ready.value.coverage.status === 'ready' && ready.value.matches.length) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const request = { claim: 'The rollback procedure says to restore the previous deployment',
    canvasId: f.canvas.id, documentIds: [f.source.id] };
  const first = await f.post<SymbiReflexResult>('/api/symbi/reflex', request);
  const second = await f.post<SymbiReflexResult>('/api/symbi/reflex', request);
  expect(first.value.verdict).toBe('yes');
  expect(first.value.passages).toEqual(expect.arrayContaining([expect.objectContaining({ contentHash: f.source.contentHash })]));
  expect(first.value.providerUsage).toMatchObject({ requests: 1, questions: 1, inputTokens: 140, outputTokens: 20 });
  expect(second.value.verdict).toBe('yes');
  expect(second.value.providerUsage.requests).toBe(0);
  expect(claimCalls).toBe(1);
  const askInput = { question: 'restore previous deployment', mode: 'combined', canvasId: f.canvas.id, limit: 1 };
  const firstAsk = await f.post<AskSymbiResult>('/api/symbi/ask', askInput);
  expect(firstAsk.value.matches).toEqual(expect.arrayContaining([expect.objectContaining({ blockId: f.source.id })]));
  expect(firstAsk.value.continuationId).toBeTruthy();
  expect(firstAsk.value.providerUsage.requests).toBe(1);
  const repeatedAsk = await f.post<AskSymbiResult>('/api/symbi/ask', { ...askInput, continuationId: firstAsk.value.continuationId });
  expect(repeatedAsk.value.providerUsage.requests).toBe(0);
  expect(askCalls).toBe(1);
}, 30000);

it('returns insufficient evidence under disabled provider policy without organizing or calling a provider', async () => {
  const f = await fixture();
  const sourceFile = path.join(f.root, f.source.file);
  const before = await readFile(sourceFile, 'utf8');
  const answer = await f.post<SymbiReflexResult>('/api/symbi/reflex', { claim: 'The rollback plan requires deleting production data',
    canvasId: f.canvas.id, documentIds: [f.source.id] });
  expect(answer.status).toBe(200);
  expect(answer.value.verdict).toBe('insufficient_evidence');
  expect(answer.value.providerUsage.requests).toBe(0);
  expect(f.provider).not.toHaveBeenCalled();
  expect(await readFile(sourceFile, 'utf8')).toBe(before);
}, 30000);

it('returns actual related documents from saved links and never treats the source as its own relative', async () => {
  const f = await fixture();
  const peer = await f.store.createBlock(f.canvas.id, { title: 'Release checklist', content: '# Checklist\nVerify health.' });
  await f.store.updateInsightLink(f.canvas.id, { type: 'link', fromBlockId: f.source.id, toBlockId: peer.id }, 'Human');
  const response = await f.post<{ items: Array<{ blockId: string; reasons: string[] }> }>('/api/symbi/related',
    { canvasId: f.canvas.id, blockId: f.source.id, limit: 10 });
  expect(response.status, JSON.stringify(response.value)).toBe(200);
  expect(response.value.items).toEqual(expect.arrayContaining([expect.objectContaining({
    blockId: peer.id, reasons: expect.arrayContaining(['linked']),
  })]));
  expect(response.value.items.every(item => item.blockId !== f.source.id)).toBe(true);
  expect(f.provider).not.toHaveBeenCalled();
}, 30000);

it('validates each brain route, cursor, and scoped related lookup without provider work', async () => {
  const f = await fixture();
  expect((await f.post('/api/symbi/ask', { question: 'rollback', mode: 'unknown' })).status).toBe(400);
  expect((await f.post('/api/symbi/find', { question: '', mode: 'semantic' })).status).toBe(400);
  expect((await f.post('/api/symbi/reflex', { claim: '' })).status).toBe(400);
  expect((await f.post('/api/symbi/related', { canvasId: f.canvas.id, blockId: f.source.id, limit: 0 })).status).toBe(400);
  expect((await f.post('/api/symbi/ask', { question: 'rollback', mode: 'semantic', cursor: 'brain:not-json' })).status).toBe(400);
  expect((await f.post('/api/symbi/related', { canvasId: f.other.id, blockId: f.source.id })).status).toBe(404);
  expect((await f.post('/api/symbi/related', { canvasId: f.canvas.id, blockId: f.source.id, cursor: '-1' })).status).toBe(400);
  const found = await f.post<AskSymbiResult>('/api/symbi/find', { question: 'Release operations', mode: 'logic', canvasId: f.canvas.id, navigate: true });
  expect(found.status).toBe(200);
  expect(found.value.matches).toEqual(expect.arrayContaining([expect.objectContaining({ canvasId: f.canvas.id, title: 'Release operations', reason: 'Canvas title match' })]));
  expect(found.value.navigation).toMatchObject({ canvasId: f.canvas.id, activated: false });
  expect(f.provider).not.toHaveBeenCalled();
}, 30000);

it('keeps saved link, group, and tag reasons when local similarity is still pending', async () => {
  const f = await fixture();
  const peer = await f.store.createBlock(f.canvas.id, { title: 'Release checklist', content: '# Checklist\nVerify health.' });
  await f.store.updateBlock(f.canvas.id, f.source.id, { group: 'custom:release', tags: ['rollout'] }, 'Human');
  await f.store.updateBlock(f.canvas.id, peer.id, { group: 'custom:release', tags: ['rollout'] }, 'Human');
  await f.store.updateInsightLink(f.canvas.id, { type: 'link', fromBlockId: f.source.id, toBlockId: peer.id }, 'Human');
  const result = await f.post<{ items: Array<{ blockId: string; reasons: string[] }> }>('/api/symbi/related',
    { canvasId: f.canvas.id, blockId: f.source.id });
  expect(result.status).toBe(200);
  expect(result.value.items.find(item => item.blockId === peer.id)?.reasons.slice(0, 3)).toEqual(['linked', 'same group', 'same topic']);
  expect(f.provider).not.toHaveBeenCalled();
}, 30000);

it('rejects a reused continuation after the question changes and validates decoded page offsets', async () => {
  let brainQuestionCalls = 0;
  const provider = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state?: { question?: string } };
    if (request.state?.question) brainQuestionCalls++;
    const answers = Object.fromEntries(Object.keys(request.questions).map(id => [id, {
      type: 'choice', choice: 'yes', probabilities: { yes: 1, no: 0, insufficient_evidence: 0 }, confidence: 1,
    }]));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const f = await fixture(provider as unknown as typeof fetch);
  expect((await fetch(f.base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: 'offline-fixture-key' } }) })).status).toBe(200);
  expect((await fetch(f.base + `/api/canvases/${f.canvas.id}/jev/settings`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalProcessing: true }) })).status).toBe(200);
  await readySource(f);
  const first = await f.post<AskSymbiResult>('/api/symbi/ask', { question: 'restore previous deployment',
    mode: 'combined', canvasId: f.canvas.id });
  expect(first.value.continuationId).toBeTruthy();
  const callsBeforeChangedQuestion = brainQuestionCalls;
  const changed = await f.post('/api/symbi/ask', { question: 'delete prior deployment', mode: 'combined',
    canvasId: f.canvas.id, continuationId: first.value.continuationId });
  expect(changed.status).toBe(409);
  expect(brainQuestionCalls).toBe(callsBeforeChangedQuestion);
  for (const page of [{ offset: -1 }, { offset: 0, cursor: 3 }, { offset: 'one' }]) {
    const cursor = 'brain:' + Buffer.from(JSON.stringify(page)).toString('base64url');
    expect((await f.post('/api/symbi/ask', { question: 'rollback', mode: 'semantic', cursor })).status).toBe(400);
  }
}, 30000);

it('returns a direct contradiction only with ready scoped evidence and no external request when the key is absent', async () => {
  const provider = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(request.questions).map(id => [id, {
      type: 'choice', choice: 'no', probabilities: { yes: 0, no: 1, insufficient_evidence: 0 }, confidence: 1,
    }]));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 2, output_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const f = await fixture(provider as unknown as typeof fetch);
  await readySource(f);
  expect((await fetch(f.base + `/api/canvases/${f.canvas.id}/jev/settings`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalProcessing: true }) })).status).toBe(200);
  const claim = { claim: 'The procedure requires deleting every deployment', canvasId: f.canvas.id, documentIds: [f.source.id] };
  const withoutKey = await f.post<SymbiReflexResult>('/api/symbi/reflex', claim);
  expect(withoutKey).toMatchObject({ status: 200, value: { verdict: 'insufficient_evidence',
    coverage: { status: 'degraded', reason: 'No provider is configured' }, providerUsage: { requests: 0 } } });
  expect(provider).not.toHaveBeenCalled();
  expect((await fetch(f.base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: 'offline-fixture-key' } }) })).status).toBe(200);
  const contradicted = await f.post<SymbiReflexResult>('/api/symbi/reflex', claim);
  expect(contradicted).toMatchObject({ status: 200, value: { verdict: 'no', confidence: 1,
    explanation: 'The checked passages contradict the claim.', providerUsage: { requests: 1 } } });
  expect(provider).toHaveBeenCalledTimes(1);
}, 30000);

it('drops stale, deleted, and wrong-excerpt evidence before scoped answers and reports pending coverage', async () => {
  const f = await fixture();
  const excerpt = 'restore the previous deployment';
  const startOffset = f.source.content.indexOf(excerpt);
  if (!f.source.contentHash) throw new Error('Fixture source is missing its content hash');
  const current: SymbiPassage = { canvasId: f.canvas.id, blockId: f.source.id,
    contentHash: f.source.contentHash, startOffset, endOffset: startOffset + excerpt.length, excerpt };
  const stale = { ...current, contentHash: 'old-source-hash' };
  const wrongExcerpt = { ...current, excerpt: 'not actually in the source' };
  const deleted = { ...current, blockId: 'deleted-document' };
  const coverage: SymbiCoverage = { status: 'ready', checkedDocuments: 1, eligibleDocuments: 1, pendingDocuments: 0 };
  const post = await controlledIndexRoute(f, [stale, wrongExcerpt, deleted, current], coverage);
  const ask = await post<AskSymbiResult>('/api/symbi/ask', { question: 'restore previous deployment', mode: 'semantic',
    canvasId: f.canvas.id, documentIds: [f.source.id] });
  expect(ask).toMatchObject({ status: 200, value: { coverage: { status: 'pending', pendingDocuments: 3 },
    matches: [expect.objectContaining({ passages: [current] })], providerUsage: { requests: 0 } } });
  const reflex = await post<SymbiReflexResult>('/api/symbi/reflex', { claim: 'The source says to restore the previous deployment',
    canvasId: f.canvas.id, documentIds: [f.source.id] });
  expect(reflex).toMatchObject({ status: 200, value: { verdict: 'insufficient_evidence', passages: [current],
    providerUsage: { requests: 0 } } });
  expect(f.provider).not.toHaveBeenCalled();
});

it('denies a tool-scoped token and reports unavailable local index without leaking a source', async () => {
  const f = await fixture();
  const coverage: SymbiCoverage = { status: 'ready', checkedDocuments: 0, eligibleDocuments: 0, pendingDocuments: 0 };
  const deniedToken = await f.store.createMcpToken('Other tools only', 'read', { allowedCanvasIds: [f.canvas.id], tools: ['read_doc'] });
  const restricted = await controlledIndexRoute(f, [], coverage, { token: deniedToken.token });
  expect((await restricted('/api/symbi/ask', { question: 'rollback', mode: 'semantic' })).status).toBe(403);
  const unavailable = await controlledIndexRoute(f, [], coverage, { index: false });
  expect((await unavailable('/api/symbi/ask', { question: 'rollback', mode: 'semantic' })).status).toBe(503);
  expect(f.provider).not.toHaveBeenCalled();
});

it('paginates related documents and local evidence without repeating an earlier page', async () => {
  const f = await fixture();
  const firstPeer = await f.store.createBlock(f.canvas.id, { title: 'First peer', content: '# First peer\nRelease checklist.' });
  const secondPeer = await f.store.createBlock(f.canvas.id, { title: 'Second peer', content: '# Second peer\nRelease checklist.' });
  await f.store.updateInsightLink(f.canvas.id, { type: 'link', fromBlockId: f.source.id, toBlockId: firstPeer.id }, 'Human');
  await f.store.updateInsightLink(f.canvas.id, { type: 'link', fromBlockId: secondPeer.id, toBlockId: f.source.id }, 'Human');
  const coverage: SymbiCoverage = { status: 'ready', checkedDocuments: 3, eligibleDocuments: 3, pendingDocuments: 0 };
  const post = await controlledIndexRoute(f, [], coverage);
  const route = '/api/symbi/related';
  const first = await post<{ items: Array<{ blockId: string; reasons: string[] }>; nextCursor?: string }>(route,
    { canvasId: f.canvas.id, blockId: f.source.id, limit: 1 });
  expect(first).toMatchObject({ status: 200, value: { nextCursor: '1', items: [expect.objectContaining({ reasons: ['linked'] })] } });
  const second = await post<typeof first.value>(route, { canvasId: f.canvas.id, blockId: f.source.id, limit: 1,
    cursor: first.value.nextCursor });
  expect(second.status).toBe(200);
  expect(second.value.nextCursor).toBeUndefined();
  expect(new Set([...first.value.items, ...second.value.items].map(item => item.blockId)))
    .toEqual(new Set([firstPeer.id, secondPeer.id]));
  expect(f.provider).not.toHaveBeenCalled();
});

it('continues a bounded semantic result page with current source evidence and no provider call', async () => {
  const f = await fixture();
  const second = await f.store.createBlock(f.canvas.id, { title: 'Health check', content: '# Health check\nVerify service health.' });
  if (!f.source.contentHash || !second.contentHash) throw new Error('Fixture hashes are missing');
  const passage = (block: typeof second, excerpt: string): SymbiPassage => ({ canvasId: f.canvas.id,
    blockId: block.id, contentHash: block.contentHash!, startOffset: block.content.indexOf(excerpt),
    endOffset: block.content.indexOf(excerpt) + excerpt.length, excerpt });
  const coverage: SymbiCoverage = { status: 'ready', checkedDocuments: 2, eligibleDocuments: 2, pendingDocuments: 0 };
  const post = await controlledIndexRoute(f, [passage(f.source, 'restore the previous deployment'),
    passage(second, 'Verify service health')], coverage);
  const first = await post<AskSymbiResult>('/api/symbi/ask', { question: 'deployment health', mode: 'semantic',
    canvasId: f.canvas.id, limit: 1 });
  expect(first).toMatchObject({ status: 200, value: { nextCursor: expect.stringMatching(/^brain:/),
    matches: [expect.objectContaining({ blockId: f.source.id })] } });
  const later = await post<AskSymbiResult>('/api/symbi/ask', { question: 'deployment health', mode: 'semantic',
    canvasId: f.canvas.id, limit: 1, cursor: first.value.nextCursor });
  expect(later).toMatchObject({ status: 200, value: { matches: [expect.objectContaining({ blockId: second.id })] } });
  expect(later.value.nextCursor).toBeUndefined();
  expect(f.provider).not.toHaveBeenCalled();
});

it('does not turn a contradictory mock judgment into a negative verdict while coverage is pending', async () => {
  const provider = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(request.questions).map(id => [id, {
      type: 'choice', choice: 'no', probabilities: { yes: 0, no: 1, insufficient_evidence: 0 }, confidence: 1,
    }]));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 2, output_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const f = await fixture(provider as unknown as typeof fetch);
  if (!f.source.contentHash) throw new Error('Fixture hash is missing');
  const excerpt = 'restore the previous deployment';
  const startOffset = f.source.content.indexOf(excerpt);
  const evidence: SymbiPassage = { canvasId: f.canvas.id, blockId: f.source.id, contentHash: f.source.contentHash,
    startOffset, endOffset: startOffset + excerpt.length, excerpt };
  expect((await fetch(f.base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: 'offline-fixture-key' } }) })).status).toBe(200);
  expect((await fetch(f.base + `/api/canvases/${f.canvas.id}/jev/settings`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalProcessing: true }) })).status).toBe(200);
  const post = await controlledIndexRoute(f, [evidence],
    { status: 'pending', checkedDocuments: 1, eligibleDocuments: 2, pendingDocuments: 1 });
  const answer = await post<SymbiReflexResult>('/api/symbi/reflex', { claim: 'Delete every deployment', canvasId: f.canvas.id,
    documentIds: [f.source.id] });
  expect(answer).toMatchObject({ status: 200, value: { verdict: 'insufficient_evidence',
    explanation: 'The checked passages do not establish a reliable answer.', coverage: { status: 'pending' } } });
  expect(answer.value.passages).toEqual([evidence]);
}, 30000);

it('refuses provider work for current evidence under disabled workspace policy and retains comparison scope', async () => {
  const f = await fixture();
  expect((await fetch(f.base + `/api/canvases/${f.canvas.id}/jev/settings`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalProcessing: false }) })).status).toBe(200);
  if (!f.source.contentHash) throw new Error('Fixture hash is missing');
  const excerpt = 'restore the previous deployment';
  const startOffset = f.source.content.indexOf(excerpt);
  const passage: SymbiPassage = { canvasId: f.canvas.id, blockId: f.source.id, contentHash: f.source.contentHash,
    startOffset, endOffset: startOffset + excerpt.length, excerpt };
  const searches: unknown[] = [];
  const post = await controlledIndexRoute(f, [passage], { status: 'ready', checkedDocuments: 1,
    eligibleDocuments: 1, pendingDocuments: 0 }, { onSearch: request => searches.push(request) });
  const result = await post<SymbiReflexResult>('/api/symbi/reflex', { claim: 'The procedure restores a deployment',
    canvasId: f.canvas.id, documentIds: [f.source.id], comparisonDocumentId: f.source.id });
  expect(result).toMatchObject({ status: 200, value: { verdict: 'insufficient_evidence',
    passages: [passage], coverage: { status: 'degraded', reason: 'Provider processing is disabled for this workspace' },
    providerUsage: { requests: 0 } } });
  const ask = await post<AskSymbiResult>('/api/symbi/ask', { question: 'restore the previous deployment',
    mode: 'combined', canvasId: f.canvas.id });
  expect(ask).toMatchObject({ status: 200, value: { matches: [], coverage: { status: 'degraded',
    reason: 'Provider processing is disabled for this workspace' }, providerUsage: { requests: 0 } } });
  expect(searches[0]).toMatchObject({ documentIds: [f.source.id], allowedDocumentIds: [f.source.id] });
  expect(f.provider).not.toHaveBeenCalled();
});

it('uses current source similarity for related navigation and accepts an unbounded claim scope', async () => {
  const f = await fixture();
  const peer = await f.store.createBlock(f.canvas.id, { title: 'Deployment health', content: '# Deployment health\nVerify service health.' });
  if (!peer.contentHash) throw new Error('Fixture peer hash is missing');
  const excerpt = 'Verify service health';
  const startOffset = peer.content.indexOf(excerpt);
  const passage: SymbiPassage = { canvasId: f.canvas.id, blockId: peer.id, contentHash: peer.contentHash,
    startOffset, endOffset: startOffset + excerpt.length, excerpt };
  const searches: unknown[] = [];
  const post = await controlledIndexRoute(f, [passage], { status: 'ready', checkedDocuments: 2,
    eligibleDocuments: 2, pendingDocuments: 0 }, { onSearch: request => searches.push(request) });
  const related = await post<{ items: Array<{ blockId: string; reasons: string[] }> }>('/api/symbi/related',
    { canvasId: f.canvas.id, blockId: f.source.id });
  expect(related).toMatchObject({ status: 200, value: { items: [expect.objectContaining({ blockId: peer.id,
    reasons: ['source similarity'], passages: [passage] })] } });
  const claim = await post<SymbiReflexResult>('/api/symbi/reflex', { claim: 'Verify service health', canvasId: f.canvas.id });
  expect(claim).toMatchObject({ status: 200, value: { verdict: 'insufficient_evidence', passages: [passage] } });
  expect(searches[1]).toMatchObject({ documentIds: undefined });
  expect(f.provider).not.toHaveBeenCalled();
});

it('returns a retry-safe degraded answer after a local mock provider failure', async () => {
  const provider = vi.fn(async () => { throw new Error('Offline provider fixture failed'); }) as unknown as typeof fetch;
  const f = await fixture(provider);
  if (!f.source.contentHash) throw new Error('Fixture hash is missing');
  const excerpt = 'restore the previous deployment';
  const startOffset = f.source.content.indexOf(excerpt);
  const passage: SymbiPassage = { canvasId: f.canvas.id, blockId: f.source.id, contentHash: f.source.contentHash,
    startOffset, endOffset: startOffset + excerpt.length, excerpt };
  expect((await fetch(f.base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: 'offline-fixture-key' } }) })).status).toBe(200);
  expect((await fetch(f.base + `/api/canvases/${f.canvas.id}/jev/settings`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalProcessing: true }) })).status).toBe(200);
  const post = await controlledIndexRoute(f, [passage], { status: 'ready', checkedDocuments: 1,
    eligibleDocuments: 1, pendingDocuments: 0 });
  const claimInput = { claim: 'The source says to restore the previous deployment', canvasId: f.canvas.id };
  const claim = await post<SymbiReflexResult>('/api/symbi/reflex', claimInput);
  expect(claim).toMatchObject({ status: 200, value: { verdict: 'insufficient_evidence',
    coverage: { status: 'degraded' }, providerUsage: { requests: 0 } } });
  const ask = await post<AskSymbiResult>('/api/symbi/ask', { question: 'restore the previous deployment',
    mode: 'combined', canvasId: f.canvas.id });
  expect(ask).toMatchObject({ status: 200, value: { coverage: { status: 'degraded' }, providerUsage: { requests: 0 },
    continuationId: expect.any(String) } });
  const empty = await controlledIndexRoute(f, [], { status: 'ready', checkedDocuments: 0,
    eligibleDocuments: 0, pendingDocuments: 0 });
  const noEvidence = await empty<AskSymbiResult>('/api/symbi/ask', { question: 'unmatched claim', mode: 'combined', canvasId: f.canvas.id });
  expect(noEvidence).toMatchObject({ status: 200, value: { matches: [], providerUsage: { requests: 0 } } });
}, 30000);

it('surfaces non-not-found source failures and a missing judgment journal before inference', async () => {
  let brainClaimCalls = 0;
  const provider = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { state?: { claim?: string } };
    if (request.state?.claim) brainClaimCalls++;
    throw new Error('The error-path fixture must not infer a claim');
  });
  const f = await fixture(provider as unknown as typeof fetch);
  if (!f.source.contentHash) throw new Error('Fixture hash is missing');
  const excerpt = 'restore the previous deployment';
  const startOffset = f.source.content.indexOf(excerpt);
  const passage: SymbiPassage = { canvasId: f.canvas.id, blockId: f.source.id, contentHash: f.source.contentHash,
    startOffset, endOffset: startOffset + excerpt.length, excerpt };
  const coverage: SymbiCoverage = { status: 'ready', checkedDocuments: 1, eligibleDocuments: 1, pendingDocuments: 0 };
  const post = await controlledIndexRoute(f, [passage], coverage);
  const originalRead = f.store.getCanvasBlock.bind(f.store);
  const failedRead = vi.spyOn(f.store, 'getCanvasBlock').mockImplementation(async (canvasId, blockId) => {
    if (canvasId === f.canvas.id && blockId === f.source.id) throw new ApiError(503, 'Source storage is unavailable');
    return originalRead(canvasId, blockId);
  });
  expect((await post('/api/symbi/ask', { question: 'rollback', mode: 'semantic', canvasId: f.canvas.id })).status).toBe(503);
  failedRead.mockRestore();
  expect((await fetch(f.base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: 'offline-fixture-key' } }) })).status).toBe(200);
  expect((await fetch(f.base + `/api/canvases/${f.canvas.id}/jev/settings`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalProcessing: true }) })).status).toBe(200);
  const noJournal = await controlledIndexRoute(f, [passage], coverage, { judgments: false });
  const before = brainClaimCalls;
  expect((await noJournal('/api/symbi/reflex', { claim: 'The source says to restore the previous deployment',
    canvasId: f.canvas.id })).status).toBe(503);
  expect(brainClaimCalls).toBe(before);
});

it('uses a stable source ID if canvas metadata changes after passage validation', async () => {
  const f = await fixture();
  if (!f.source.contentHash) throw new Error('Fixture hash is missing');
  const excerpt = 'restore the previous deployment';
  const startOffset = f.source.content.indexOf(excerpt);
  const passage: SymbiPassage = { canvasId: f.canvas.id, blockId: f.source.id, contentHash: f.source.contentHash,
    startOffset, endOffset: startOffset + excerpt.length, excerpt };
  const originalSummary = f.store.getCanvasSummary.bind(f.store);
  const summary = vi.spyOn(f.store, 'getCanvasSummary').mockImplementation(async canvasId => {
    const actual = await originalSummary(canvasId);
    return canvasId === f.canvas.id ? { ...actual, blocks: [] } : actual;
  });
  const post = await controlledIndexRoute(f, [passage], { status: 'ready', checkedDocuments: 1,
    eligibleDocuments: 1, pendingDocuments: 0 });
  const result = await post<AskSymbiResult>('/api/symbi/ask', { question: 'rollback', mode: 'semantic', canvasId: f.canvas.id });
  summary.mockRestore();
  expect(result).toMatchObject({ status: 200, value: { matches: [expect.objectContaining({
    blockId: f.source.id, title: f.source.id, passages: [passage] })] } });
  expect(f.provider).not.toHaveBeenCalled();
});

it('treats a malformed cached choice as insufficient evidence with zero confidence', async () => {
  const f = await fixture();
  if (!f.source.contentHash) throw new Error('Fixture hash is missing');
  const excerpt = 'restore the previous deployment';
  const startOffset = f.source.content.indexOf(excerpt);
  const passage: SymbiPassage = { canvasId: f.canvas.id, blockId: f.source.id, contentHash: f.source.contentHash,
    startOffset, endOffset: startOffset + excerpt.length, excerpt };
  expect((await fetch(f.base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: 'offline-fixture-key' } }) })).status).toBe(200);
  expect((await fetch(f.base + `/api/canvases/${f.canvas.id}/jev/settings`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalProcessing: true }) })).status).toBe(200);
  const post = await controlledIndexRoute(f, [passage], { status: 'ready', checkedDocuments: 1,
    eligibleDocuments: 1, pendingDocuments: 0 }, { judgmentOverride: { state: 'complete', reused: true,
    value: { answers: { verdict: { type: 'text', text: 'unclear' } },
      usage: { requests: 1, questions: 1, inputTokens: 2, outputTokens: 1 } } } });
  const answer = await post<SymbiReflexResult>('/api/symbi/reflex', { claim: 'The source restores a deployment',
    canvasId: f.canvas.id });
  expect(answer).toMatchObject({ status: 200, value: { verdict: 'insufficient_evidence', confidence: 0,
    explanation: 'The checked passages do not establish a reliable answer.', providerUsage: { requests: 0 } } });
});

it('leaves unrelated local Jev usage outside the brain request counter', async () => {
  const localProvider = vi.fn(async () => new Response(JSON.stringify({ answers: { check: {
    type: 'choice', choice: 'yes', probabilities: { yes: 1, no: 0 }, confidence: 1,
  } }, usage: { input_tokens: 4, output_tokens: 2 } }),
  { status: 200, headers: { 'content-type': 'application/json' } }));
  const answer = await decideWithJev('offline-fixture-key', { scope: 'unrelated local test' },
    { check: choice('Check the offline fixture', { yes: 'Supported', no: 'Not supported' }) },
    localProvider as unknown as typeof fetch, { maxRetries: 0 });
  expect(answer.check).toMatchObject({ type: 'choice', choice: 'yes' });
  expect(localProvider).toHaveBeenCalledTimes(1);
});
