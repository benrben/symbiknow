import { automaticRecall } from './automatic.js';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jevActions, type JevActionRequest, type JevEvaluation, type JevPassage, type JevValues } from '../../../shared/jev-types.js';
import type { CanvasBlock } from '../../../shared/types.js';
import { decideWithJev, type JevAnswer, type JevDecider, type JevQuestion } from '../../jev.js';
import { type JevEvaluationContext, type JevInputDocument } from '../actions.js';
import { recall } from './serving.js';

type PassageState = { query: string; passage: string };
type ProviderBody = { state: PassageState & { questionSets?: PassageState[] }; questions: Record<string, JevQuestion> };
type Rating = { relevance: number; conflict: number };
let server: Server;
let origin: string;
let requests: ProviderBody[] = [];
let ratings = new Map<number, Rating>();
let responseStatus = 200;
let holdResponse = false;
let requestReceived: (() => void) | undefined;
const heldResponses = new Set<ServerResponse>();

function answer(id: string, body: ProviderBody): JevAnswer {
  const match = /^(\d+)__(.+)$/.exec(id);
  const state = match ? body.state.questionSets![Number(match[1])] : body.state;
  const question = match ? match[2] : id;
  const candidate = Number(/candidate-(\d+)/.exec(state.passage)![1]);
  const rating = ratings.get(candidate) ?? { relevance: 0.9, conflict: 0.1 };
  return { type: 'noul', noul: rating[question as keyof Rating] };
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += String(chunk);
    const body = JSON.parse(input) as ProviderBody;
    requests.push(body);
    requestReceived?.();
    if (holdResponse) { heldResponses.add(response); return; }
    response.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    if (responseStatus !== 200) { response.end(JSON.stringify({ detail: 'Provider is temporarily unavailable' })); return; }
    const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id, answer(id, body)]));
    response.end(JSON.stringify({ answers }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Native recall provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
afterEach(() => { for (const response of heldResponses) response.destroy(); heldResponses.clear(); });
beforeEach(() => { requests = []; ratings = new Map(); responseStatus = 200; holdResponse = false; requestReceived = undefined; });

const nativeDecider: JevDecider = (key, state, questions, _fetcher, options) =>
  decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options);

function document(index: number, canvasId = 'canvas', patch: Partial<CanvasBlock> = {}): JevInputDocument {
  const id = `source-${index}`;
  return { canvasId, snapshot: { workspaceId: 'workspace', canvasId, blockId: id, incarnation: `inc_${id}`,
    sourceGeneration: 4, metadataRevision: 3, contentHash: `hash_${id}` },
  block: { id, title: 'Atlas rollout', file: `${id}.md`,
    content: `Atlas rollout candidate-${index * 2} requires a signed release.\n\nAtlas rollout candidate-${index * 2 + 1} records the release decision.`,
    kind: 'markdown', x: 32, y: 64, width: 400, height: 300, links: [], ...patch } };
}
function context(documents = [document(0)]): JevEvaluationContext {
  return { workspaceId: 'workspace', documents, canvases: [{ id: 'canvas', name: 'Atlas' }, { id: 'other', name: 'Delivery' }],
    tasks: [], vocabulary: [], apiKey: 'local-fixture', now: new Date('2026-10-04T12:00:00Z'),
    settings: { paused: false, externalProcessing: true, people: [], schedules: [],
      modes: Object.fromEntries(jevActions.map(action => [action, 'auto'])) as JevEvaluationContext['settings']['modes'] },
    decider: nativeDecider };
}
function request(query = 'Atlas rollout'): JevActionRequest { return { action: 'recall', canvasId: 'canvas', query }; }
function passages(result: JevEvaluation): JevValues[] { return result.result.passages as JevValues[]; }
function states(): PassageState[] { return requests.flatMap(body => body.state.questionSets ?? [body.state]); }
function candidate(value: JevValues): number {
  return Number(/candidate-(\d+)/.exec((value.passage as unknown as JevPassage).quote)![1]);
}

describe('native supporting-passage question batching', () => {
  it('rates twelve independent exact passages in one request and maps relevance and conflicts to their original snapshots', async () => {
    const documents = Array.from({ length: 6 }, (_, index) => document(index, index === 5 ? 'other' : 'canvas'));
    documents[0].block.freshness = { reviewAt: '2026-11-04T12:00:00Z', effectiveAt: '2026-10-04T12:00:00Z' };
    for (let index = 0; index < 12; index++) ratings.set(index, { relevance: 0.6 + index * 0.03, conflict: index % 3 === 0 ? 0.9 : 0.1 });
    const original = structuredClone(documents);
    const result = await automaticRecall(context(documents), request());
    expect(requests).toHaveLength(1);
    expect(states()).toHaveLength(12);
    expect(Object.keys(requests[0].questions)).toHaveLength(24);
    for (const [id, question] of Object.entries(requests[0].questions)) {
      expect(question.type).toBe('noul');
      expect(question.instructions).toContain(`Use only questionSets[${id.split('__')[0]}]`);
    }
    expect(states().map(state => state.passage)).toEqual(documents.flatMap(document => document.block.content.split('\n\n')));
    expect(states().every(state => state.query === 'Atlas rollout')).toBe(true);
    expect(result.result).toMatchObject({ evidenceFound: true, evidenceStatus: 'verified_support', candidateCount: 12,
      searchedCanvasIds: ['canvas', 'other'], coverage: 'bounded_local_candidates', reranking: 'available' });
    expect(passages(result).map(candidate)).toEqual(Array.from({ length: 12 }, (_, index) => 11 - index));
    for (const value of passages(result)) {
      const id = candidate(value);
      expect(value.relevance).toBe(ratings.get(id)!.relevance);
      expect(value.rerankStatus).toBe('rated');
      const passage = value.passage as unknown as JevPassage;
      const source = documents.find(document => document.block.id === value.blockId)!;
      expect(passage.source).toEqual(source.snapshot);
      expect(source.block.content.slice(passage.start, passage.end)).toBe(passage.quote);
      expect(value.freshness).toEqual(source.block.freshness ?? null);
    }
    const conflicts = result.result.conflicts as JevValues[];
    expect(conflicts.map(candidate)).toEqual([0, 3, 6, 9]);
    expect(conflicts.every(value => value.kind === 'premise_conflict' && value.confidence === 0.9)).toBe(true);
    expect(result.proposals).toEqual([]);
    expect(documents).toEqual(original);
  });

  it.each([0.65, 0.85])('uses the configured %s recall threshold for support and premise conflicts after batching', async threshold => {
    const input = context(); input.confidenceThreshold = threshold;
    ratings.set(0, { relevance: 0.75, conflict: 0.75 });
    ratings.set(1, { relevance: 0.1, conflict: 0.1 });
    const result = await automaticRecall(input, request());
    expect(requests).toHaveLength(1);
    expect(states()).toHaveLength(2);
    expect(result.result.evidenceFound).toBe(threshold < 0.75);
    expect(result.result.evidenceStatus).toBe(threshold < 0.75 ? 'verified_support' : 'no_verified_support');
    expect(result.result.conflicts).toHaveLength(threshold < 0.75 ? 1 : 0);
    expect(passages(result).map(value => value.relevance)).toEqual([0.75, 0.1]);
  });

  it('keeps excluded passages local, omits foreign workspace and archived content, and includes archived sources only when requested', async () => {
    const excluded = document(1, 'canvas', { processingExcluded: true });
    const foreign = document(2); foreign.snapshot.workspaceId = 'private-workspace';
    const archived = document(3, 'other', { archived: true });
    const input = context([document(0), excluded, foreign, archived]);
    const result = await automaticRecall(input, request());
    expect(states().map(state => state.passage)).toEqual(input.documents[0].block.content.split('\n\n'));
    expect(JSON.stringify(requests)).not.toContain('candidate-2');
    expect(JSON.stringify(requests)).not.toContain('candidate-4');
    expect(JSON.stringify(requests)).not.toContain('candidate-6');
    expect(passages(result).filter(value => value.blockId === excluded.block.id)).toEqual([
      expect.objectContaining({ rerankStatus: 'excluded_from_external_processing', freshness: null }),
      expect.objectContaining({ rerankStatus: 'excluded_from_external_processing', freshness: null }),
    ]);
    expect(passages(result).some(value => value.blockId === foreign.block.id || value.blockId === archived.block.id)).toBe(false);
    requests = [];
    const withArchived = await automaticRecall(input, { ...request(), options: { includeArchived: true } });
    expect(requests).toHaveLength(1);
    expect(states()).toHaveLength(4);
    expect(passages(withArchived).filter(value => value.blockId === archived.block.id)).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain('candidate-2');
    expect(JSON.stringify(requests)).not.toContain('candidate-4');
  });

  it('does not contact the provider without a query, a local match, or externally eligible candidates', async () => {
    const input = context();
    for (const query of [undefined, ' \n ']) {
      expect(await recall(input, { action: 'recall', canvasId: 'canvas', query })).toEqual({
        result: { status: 'missing_query', passages: [], conflicts: [] }, proposals: [] });
    }
    for (const empty of [context([]), input]) {
      const result = await automaticRecall(empty, request('Unrelated nebula'));
      expect(result.result).toMatchObject({ evidenceFound: false, evidenceStatus: 'no_verified_support', candidateCount: 0 });
    }
    input.documents[0].block.processingExcluded = true;
    const excluded = await automaticRecall(input, request());
    expect(excluded.result).toMatchObject({ evidenceFound: false, evidenceStatus: 'local_unverified', candidateCount: 2 });
    expect(passages(excluded).every(value => value.rerankStatus === 'excluded_from_external_processing')).toBe(true);
    expect(requests).toEqual([]);
  });

  it('preserves exact local results and lexical order when external processing is disabled', async () => {
    const input = context(); input.settings.externalProcessing = false;
    const result = await automaticRecall(input, request());
    expect(requests).toEqual([]);
    expect(result.result).toMatchObject({ evidenceFound: false, evidenceStatus: 'local_unverified', candidateCount: 2,
      reranking: 'unavailable_local_fallback', conflicts: [] });
    expect(passages(result).every(value => value.rerankStatus === 'unrated' && value.relevance === undefined && Number(value.lexicalScore) > 0)).toBe(true);
    expect(passages(result).map(value => (value.passage as unknown as JevPassage).quote)).toEqual(input.documents[0].block.content.split('\n\n'));
    expect(JSON.stringify(result)).not.toContain(input.apiKey);
  });

  it('falls back without partial ratings after one actual provider 503 response', async () => {
    responseStatus = 503;
    const result = await automaticRecall(context(), request());
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].questions)).toHaveLength(4);
    expect(result.result).toMatchObject({ evidenceFound: false, evidenceStatus: 'local_unverified',
      candidateCount: 2, reranking: 'unavailable_local_fallback', conflicts: [] });
    expect(passages(result).every(value => value.rerankStatus === 'unrated' && value.relevance === undefined)).toBe(true);
  });

  it('propagates SDK cancellation of an in-flight native HTTP request without returning local fallback', async () => {
    const controller = new AbortController();
    const input = context(); input.signal = controller.signal; holdResponse = true;
    const received = new Promise<void>(resolve => { requestReceived = resolve; });
    const pending = automaticRecall(input, request());
    const rejected = expect(pending).rejects.toMatchObject({ status: 499, message: 'Jev request was cancelled' });
    await received;
    expect(requests).toHaveLength(1);
    controller.abort();
    await rejected;
  });

  it('propagates unexpected adapter defects after a real successful SDK decision', async () => {
    const input = context();
    const defect = new Error('Unexpected recall adapter defect');
    input.decider = async (...args) => { await nativeDecider(...args); throw defect; };
    await expect(automaticRecall(input, request())).rejects.toBe(defect);
    expect(requests).toHaveLength(1);
    expect(states()).toHaveLength(2);
  });
});
