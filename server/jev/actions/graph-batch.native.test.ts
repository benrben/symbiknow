import { pairFinding, recheckLinks } from './graph.js';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jevActions, type JevActionRequest, type JevEvaluation } from '../../../shared/jev-types.js';
import type { CanvasBlock } from '../../../shared/types.js';
import { decideWithJev, estimateJevTokens, type JevAnswer, type JevQuestion } from '../../jev.js';
import { evaluateJevAction, type JevEvaluationContext, type JevInputDocument } from '../actions.js';

type PairState = { source: { id: string }; target: { id: string }; hypothesis: string };
type ProviderBody = { state: PairState & { questionSets?: PairState[] }; questions: Record<string, JevQuestion> };
type DecisionRule = (id: string, pair: PairState, question: JevQuestion) => string | number | undefined;
let server: Server;
let origin: string;
let requests: ProviderBody[] = [];
let rule: DecisionRule = () => undefined;
let invalidAnswer = false;

function responseAnswer(id: string, question: JevQuestion, body: ProviderBody): JevAnswer {
  const match = /^(\d+)__(.+)$/.exec(id);
  const pair = match ? body.state.questionSets![Number(match[1])] : body.state;
  const name = match ? match[2] : id;
  const selected = rule(name, pair, question) ?? (name === 'relation' ? 'related' : undefined);
  if (question.type === 'noul') return { type: 'noul', noul: Number(selected ?? 0.98) };
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const choice = String(selected ?? (question.type === 'score' ? '2' : keys[0]));
  const probabilities = Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0]));
  if (question.type === 'choice') return { type: 'choice', choice, confidence: 0.99, probabilities };
  return { type: 'score', score: Number(choice), confidence: 0.99, probabilities };
}
beforeAll(async () => {
  server = createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += String(chunk);
    const body = JSON.parse(input) as ProviderBody;
    requests.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) =>
      [id, responseAnswer(id, question, body)]));
    if (invalidAnswer) delete answers[Object.keys(answers)[0]];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ answers }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Native graph provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
beforeEach(() => { requests = []; rule = () => undefined; invalidAnswer = false; });

function document(id: string, canvasId = 'canvas', patch: Partial<CanvasBlock> = {}): JevInputDocument {
  return { canvasId, snapshot: { workspaceId: 'workspace', canvasId, blockId: id, incarnation: `inc_${id}`,
    sourceGeneration: 4, metadataRevision: 3, contentHash: `hash_${id}` },
  block: { id, title: 'Atlas rollout', file: `${id}.md`, content: `Atlas rollout ${id} requirements.\n\nAtlas rollout ${id} decision.`,
    kind: 'markdown', x: 32, y: 64, width: 400, height: 300, links: [], ...patch } };
}
function context(documents: JevInputDocument[]): JevEvaluationContext {
  return { workspaceId: 'workspace', documents, canvases: [{ id: 'canvas', name: 'Atlas' }, { id: 'other', name: 'Delivery' }],
    tasks: [], vocabulary: [], apiKey: 'local-fixture', now: new Date('2026-10-04T12:00:00Z'),
    settings: { paused: false, externalProcessing: true, people: [], schedules: [],
      modes: Object.fromEntries(jevActions.map(action => [action, 'auto'])) as JevEvaluationContext['settings']['modes'] },
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions,
      (_url, init) => fetch(origin, init), options) };
}
function action(action: JevActionRequest['action'], blockIds = ['one']): JevActionRequest {
  return { action, canvasId: 'canvas', blockIds };
}
function sourcePatch(result: JevEvaluation, blockId: string) {
  const candidate = result.proposals.find(proposal => proposal.mutation.kind === 'document' && proposal.mutation.blockId === blockId);
  if (!candidate || candidate.mutation.kind !== 'document') throw new Error(`Missing native source patch ${blockId}`);
  return candidate.mutation.patch;
}
function pairs() {
  return requests.flatMap(body => body.state.questionSets ?? [body.state])
    .map(pair => `${pair.source.id}->${pair.target.id}`);
}

describe('native graph question batching', () => {
  it('judges all directed links together and maps each exact endpoint quote and confidence back in source order', async () => {
    const documents = [document('one', 'canvas', { links: ['manual'] }), document('two'), document('three', 'other')];
    rule = (id, pair) => id === 'supported' ? (pair.target.id === 'two' ? 0.91 : 0.97)
      : id === 'sourceEvidence' ? 'p1' : undefined;
    const result = await evaluateJevAction(context(documents), { ...action('link', ['one', 'two']), options: { relation: 'implements' } });
    expect(requests).toHaveLength(1);
    expect(pairs()).toEqual(['one->three', 'one->two', 'two->one', 'two->three']);
    expect(Object.keys(requests[0].questions)).toHaveLength(16);
    for (const [id, question] of Object.entries(requests[0].questions)) {
      expect(question.instructions).toContain(`Use only questionSets[${id.split('__')[0]}]`);
    }
    expect(result.result.verifiedPairs).toBe(4);
    expect(sourcePatch(result, 'one')).toEqual({ links: ['manual', 'two'], linkTypes: { two: 'implements' },
      crossLinks: [{ canvasId: 'other', blockId: 'three', relation: 'implements', confidence: 0.97 }] });
    expect(result.proposals.map(proposal => proposal.sources.map(source => source.blockId))).toEqual([
      ['one', 'three', 'two'], ['two', 'one', 'three']]);
    expect(result.proposals[0].decisionConfidences).toEqual([0.97, 0.91]);
    expect(result.proposals[0].evidence.map(item => [item.source.blockId, item.quote])).toEqual([
      ['one', 'Atlas rollout one decision.'], ['three', 'Atlas rollout three requirements.'],
      ['one', 'Atlas rollout one decision.'], ['two', 'Atlas rollout two requirements.']]);
    for (const item of result.proposals.flatMap(proposal => proposal.evidence)) {
      const source = documents.find(document => document.block.id === item.source.blockId)!;
      expect(source.block.content.slice(item.start, item.end)).toBe(item.quote);
      expect(item.source).toEqual(source.snapshot);
    }
    expect(documents[0].block.links).toEqual(['manual']);
  });

  it('keeps unsupported, missing endpoint evidence, and useless link answers isolated from eligible pairs', async () => {
    const input = context(['one', 'missing-source', 'missing-target', 'unsupported', 'useless', 'valid'].map(id => document(id)));
    rule = (id, pair) => {
      if (id === 'supported' && pair.target.id === 'unsupported') return 0.04;
      if (id === 'sourceEvidence' && pair.target.id === 'missing-source') return 'none';
      if (id === 'targetEvidence' && pair.target.id === 'missing-target') return 'unknown';
      if (id === 'usefulness' && pair.target.id === 'useless') return 0;
      return undefined;
    };
    const result = await evaluateJevAction(input, action('link'));
    expect(requests).toHaveLength(1);
    expect(result.result.verifiedPairs).toBe(5);
    expect(result.result.edges).toEqual([{ sourceId: 'one', targetId: 'valid', targetCanvasId: 'canvas',
      relation: 'related', confidence: 0.98, usefulness: 2 }]);
    expect(sourcePatch(result, 'one')).toEqual({ links: ['valid'], linkTypes: { valid: 'related' } });
  });

  it('does not rewrite matching current links and retains every other existing cross-canvas endpoint', async () => {
    const source = document('one', 'canvas', { links: ['two'], linkTypes: { two: 'related' },
      crossLinks: [{ canvasId: 'other', blockId: 'unavailable', relation: 'prerequisite' },
        { canvasId: 'elsewhere', blockId: 'three', relation: 'related' },
        { canvasId: 'other', blockId: 'three', relation: 'related', confidence: 0.98 }] });
    const original = structuredClone(source);
    const result = await evaluateJevAction(context([source, document('two'), document('three', 'other')]), action('link'));
    expect(requests).toHaveLength(1);
    expect(result.result.edges).toHaveLength(2);
    expect(result.proposals).toEqual([]);
    expect(source).toEqual(original);
  });

  it('reports a supported managed edge without rewriting an identical patch, and protects a pinned edge', async () => {
    const source = document('one', 'canvas', { links: ['two'], linkTypes: { two: 'related' },
      jevOwnership: { managed: ['link:canvas:two'], pins: [], removedLabels: [], removedLinks: [] } });
    const input = context([source, document('two')]);
    const unchanged = await evaluateJevAction(input, action('link'));
    expect(unchanged.result.edges).toMatchObject([{ targetId: 'two', relation: 'related' }]);
    expect(unchanged.proposals).toEqual([]);
    source.block.jevOwnership!.pins = ['link:canvas:two'];
    const pinned = await evaluateJevAction(input, action('link'));
    expect(pinned.result.edges).toMatchObject([{ targetId: 'two', relation: 'related' }]);
    expect(pinned.proposals).toEqual([]);
    expect(source.block.links).toEqual(['two']);
  });

  it('keeps retired conflict checks semantic and does not call blank duplicate content exact evidence', async () => {
    const source = document('one');
    const same = document('two', 'canvas', { content: source.block.content });
    const conflict = await pairFinding(context([source, same]), action('flag_conflict'));
    expect(requests).toHaveLength(1);
    expect(conflict.result.findings).toMatchObject([{ kind: 'conflict', method: 'semantic_review' }]);
    expect(conflict.proposals[0]).toMatchObject({ title: 'Conflicting claims' });
    requests = [];
    source.block.content = '   '; source.block.links = ['two']; same.block.content = '   ';
    const blank = await pairFinding(context([source, same]), action('flag_duplicate'));
    expect(requests).toHaveLength(1);
    expect(blank.result.findings).toEqual([]);
    expect(blank.proposals).toEqual([]);
  });

  it.each(['flag_duplicate'] as const)('batches %s once after symmetric pair deduplication without changing the original direction', async actionName => {
    const input = context([document('one'), document('two'), document('three'), document('four', 'other')]);
    rule = (id, pair) => id === 'supported' && pair.target.id === 'three' ? 0.05 : undefined;
    const result = await evaluateJevAction(input, action(actionName, ['one', 'two']));
    expect(requests).toHaveLength(1);
    expect(pairs()).toEqual(['one->four', 'one->three', 'one->two', 'two->four', 'two->three']);
    expect(result.proposals.map(proposal => proposal.sources.map(source => source.blockId))).toEqual([
      ['one', 'four'], ['one', 'two'], ['two', 'four']]);
    expect(result.result.findings).toHaveLength(3);
    expect(result.proposals.every(proposal => proposal.confidence === 0.98 && proposal.evidence.length === 2)).toBe(true);
  });

  it('rechecks every source together while retaining relation direction and protecting manual and pinned edges', async () => {
    const source = document('one', 'canvas', { links: ['two', 'three'], linkTypes: { two: 'prerequisite' },
      crossLinks: [{ canvasId: 'other', blockId: 'four', relation: 'implements' }, { canvasId: 'other', blockId: 'five' }],
      jevOwnership: { managed: ['link:canvas:two', 'link:other:four', 'link:other:five'], pins: ['link:other:five'], removedLabels: [], removedLinks: [] } });
    const second = document('two', 'canvas', { links: ['one'] });
    const input = context([source, second, document('three'), document('four', 'other'), document('five', 'other')]);
    rule = (id, pair) => id === 'supported' ? (pair.target.id === 'three' ? 0.61 : pair.source.id === 'two' ? 0.98 : 0.03) : undefined;
    const result = await recheckLinks(input, action('recheck_links', ['one', 'two']));
    expect(requests).toHaveLength(1);
    expect(pairs()).toEqual(['one->two', 'one->three', 'one->four', 'one->five', 'two->one']);
    expect(requests[0].state.questionSets!.map(pair => pair.hypothesis)).toEqual([
      'source depends on target to be understood or carried out',
      'target supplies specific useful supporting context when reading source',
      'source implements the explicit requirements or plan in target',
      'target supplies specific useful supporting context when reading source',
      'target supplies specific useful supporting context when reading source']);
    expect(sourcePatch(result, 'one')).toEqual({ links: ['three'], linkTypes: {},
      crossLinks: [{ canvasId: 'other', blockId: 'five' }] });
    expect(result.result.edges).toMatchObject([
      { targetId: 'two', status: 'unsupported' }, { targetId: 'three', status: 'insufficient_evidence' },
      { targetId: 'four', status: 'unsupported' }, { targetId: 'five', status: 'unsupported' },
      { targetId: 'one', status: 'fresh' }]);
    expect(result.proposals[1].decisionConfidences).toEqual([0.97, 0.97]);
    expect(source.block.links).toEqual(['two', 'three']);
    expect(second.block.links).toEqual(['one']);
  });

  it('makes no provider request without graph pairs and preserves single-pair wire compatibility', async () => {
    const single = context([document('one')]);
    for (const actionName of ['link', 'flag_duplicate'] as const) {
      await evaluateJevAction(single, action(actionName));
    }
    expect(requests).toEqual([]);
    await evaluateJevAction(context([document('one'), document('two')]), action('link'));
    expect(requests).toHaveLength(1);
    expect(requests[0].state.questionSets).toBeUndefined();
    expect(Object.keys(requests[0].questions)).toEqual(['supported', 'sourceEvidence', 'targetEvidence', 'usefulness', 'relation']);
  });

  it('splits large independent sets into bounded requests and aborts the whole result on an invalid provider answer', async () => {
    const documents = Array.from({ length: 4 }, (_, index) => document(['one', 'two', 'three', 'four'][index]));
    for (const source of documents) source.block.content = Array.from({ length: 8 }, (_, index) =>
      `Atlas paragraph ${index} ${'requirements '.repeat(45)}`).join('\n\n');
    const input = context(documents);
    await evaluateJevAction(input, action('link', ['one', 'two', 'three', 'four']));
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.length).toBeLessThan(12);
    expect(pairs()).toHaveLength(12);
    for (const body of requests) expect(estimateJevTokens(body.state) + estimateJevTokens(body.questions)).toBeLessThanOrEqual(16000);
    requests = []; invalidAnswer = true;
    await expect(evaluateJevAction(context([document('one'), document('two'), document('three')]), action('link')))
      .rejects.toMatchObject({ status: 502 });
    expect(requests).toHaveLength(1);
  });
});
