import { pairFinding, recheckLinks } from './graph.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jevActions, type JevActionRequest, type JevEvaluation, type JevWorkspaceState } from '../../../shared/jev-types.js';
import type { CanvasBlock } from '../../../shared/types.js';
import { decideWithJev, estimateJevTokens, type JevAnswer, type JevQuestion } from '../../jev.js';
import { updatedBlock } from '../../storage-validation.js';
import { createApiServer } from '../../index.js';
import { CanvasStore } from '../../storage.js';
import { storedBlock } from '../../storage-shapes.js';
import { sourceSnapshot } from '../stamps.js';
import { JevWorkspaceFiles } from '../workspace.js';
import { evaluateJevAction, type JevEvaluationContext, type JevInputDocument } from '../actions.js';
import { compileSharedQuestionStates } from './question-state-pool.js';
import { resolveSharedQuestionSources } from './question-state-pool.test.helpers.js';

type PairState = { source: { id: string }; target: { id: string }; hypothesis: string };
type ProviderBody = { state: PairState & { questionSets?: PairState[]; sourceStates?: unknown }; questions: Record<string, JevQuestion> };
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
  const selected = rule(name, pair, question) ?? (name === 'relation' ? 'related' : name === 'overlap' ? 'distinct' : undefined);
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
afterEach(() => {
  for (const body of requests) {
    const states = resolveSharedQuestionSources(body.state.questionSets ?? [body.state], body.state.sourceStates);
    const scopes = states.map(state => JSON.stringify(compileSharedQuestionStates([state]).sourceStates.map(source => JSON.stringify(source)).sort()));
    expect(new Set(scopes).size).toBe(1);
  }
});

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

async function launchFixture(): Promise<JevInputDocument[]> {
  const names = ['launch-blockers', 'sso-security-review', 'pen-test', 'access-policy',
    'rollback-runbook', 'rollback-runbook-copy', 'pricing-decision', 'pricing-copy'];
  return Promise.all(names.map(async id => {
    const content = await readFile(new URL(`../../../features/fixtures/shared-memory-launch/${id}.md`, import.meta.url), 'utf8');
    return document(id, 'canvas', { title: content.match(/^# (.+)/)![1], content });
  }));
}

const actualPricingCopy = `# Pricing page copy (draft)

Headline: *One shared memory for your team and its agents.*

- Free: start alone, invite later
- Pro: for teams that write and decide together
- Enterprise: SSO, audit history, and a named contact

Still needed: final Pro price from the pricing decision, FAQ section.
`;
const actualPricingDecision = `# Pricing tiers decision

Decision: launch with **three tiers**.

| Tier | Price | For |
| --- | --- | --- |
| Free | $0 | Individuals, 3 canvases |
| Pro | $24 per user / month | Small teams |
| Enterprise | Custom | SSO, audit history, priority support |

Enterprise requires the SSO review to be complete.
`;
const actualRollbackBody = `Use this when a release must be undone.

1. Freeze deploys in the release channel
2. Redeploy the previous tagged build
3. Run the smoke tests against production
4. Post a status update with the incident link

Owner: on-call engineer. Target: rollback in under 15 minutes.
`;

describe('native graph question batching', () => {
  it('asks for the most specific source-to-target relation when an untagged actual pricing draft needs the decision', async () => {
    const source = document('pricing-copy', 'canvas', { title: 'Pricing page copy', content: actualPricingCopy });
    const target = document('pricing-decision', 'canvas', { title: 'Pricing tiers decision', content: actualPricingDecision });
    rule = id => id === 'relation' ? 'prerequisite' : undefined;
    const result = await evaluateJevAction(context([source, target]), action('link', [source.block.id]));
    expect(requests).toHaveLength(1);
    const questions = requests[0].questions;
    expect(questions.relation.instructions).toMatch(/most specific/);
    if (questions.relation.type !== 'choice') throw new Error('Expected relationship choice');
    expect(questions.relation.criteria.prerequisite).toMatch(/source needs target/);
    expect(questions.supported.instructions).toMatch(/useful context/);
    expect(result.result.edges).toMatchObject([{ targetId: target.block.id, relation: 'prerequisite' }]);
    expect(source.block).not.toHaveProperty('tags');
    expect(source.block).not.toHaveProperty('group');
    expect(target.block).not.toHaveProperty('tags');
    expect(target.block).not.toHaveProperty('group');
  });

  it('flags the actual rollback near-copy with a different leading title using exact body evidence and no provider', async () => {
    const source = document('rollback', 'canvas', { title: 'Rollback runbook', content: '# Rollback runbook\n\n' + actualRollbackBody });
    const target = document('rollback-copy', 'canvas', { title: 'Rollback steps (copy)', content: '# Rollback steps (copy)\n\n' + actualRollbackBody });
    const before = structuredClone([source, target]);
    rule = id => id === 'supported' ? 0.1 : undefined;
    const result = await evaluateJevAction(context([source, target]), action('flag_duplicate', [source.block.id]));
    expect(result.result.findings).toEqual([{ kind: 'duplicate', targetCanvasId: 'canvas', targetId: target.block.id,
      confidence: 1, status: 'detected', method: 'substantive_content', overlap: 'copy', calibration: 1 }]);
    expect(result.proposals[0].mutation.kind).toBe('derived');
    expect(result.proposals[0].evidence).toHaveLength(2);
    for (const item of result.proposals[0].evidence) {
      const original = [source, target].find(document => document.block.id === item.source.blockId)!;
      expect(item.quote).toBe('Use this when a release must be undone.');
      expect(original.block.content.slice(item.start, item.end)).toBe(item.quote);
      expect(item.source).toEqual(original.snapshot);
    }
    expect([source, target]).toEqual(before);
    expect(requests).toEqual([]);
  });

  it.each([
    ['changed recovery target', actualRollbackBody.replace('under 15 minutes', 'under 30 minutes')],
    ['changed code', actualRollbackBody + '\n```sh\nrestore --production\n```\n'],
    ['changed subsequent heading', '## Staging only\n\n' + actualRollbackBody],
    ['code-only body', '```sh\nrestore --production\n```\n'],
  ])('does not force a body-equivalent duplicate when %s changes source meaning', async (_name, body) => {
    const source = document('original', 'canvas', { content: '# Original\n\n' + actualRollbackBody });
    const target = document('updated', 'canvas', { content: '# Updated\n\n' + body });
    rule = id => id === 'supported' ? 0.1 : undefined;
    const result = await evaluateJevAction(context([source, target]), action('flag_duplicate', [source.block.id]));
    expect(result.result.findings).toEqual([]);
    expect(result.proposals).toEqual([]);
  });

  it('normalizes only leading title and surrounding blank format while retaining original quote offsets', async () => {
    const source = document('original', 'canvas', { content: '# Original\n\n' + actualRollbackBody });
    const target = document('copy', 'canvas', { content: '\n\n# Copy\r\n\r\n' + actualRollbackBody.replace(/\n/g, '\r\n') + '\r\n\t\r\n' });
    const result = await evaluateJevAction(context([source, target]), action('flag_duplicate', [source.block.id]));
    expect(result.result.findings).toMatchObject([{ method: 'substantive_content', targetId: target.block.id }]);
    for (const evidence of result.proposals[0].evidence) {
      const document = [source, target].find(item => item.block.id === evidence.source.blockId)!;
      expect(document.block.content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
    }
    expect(requests).toEqual([]);
  });

  it('runs actual untagged pricing and heading-only rollback cases through the public engine API and durable reload', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'symbi-actual-graph-'));
    let api: Server | undefined;
    try {
      const store = new CanvasStore(root); await store.init();
      const workspace = await store.createWorkspace({ name: 'Actual launch graph' });
      const canvas = await store.createCanvas(workspace.id, { name: 'Original user documents' });
      const pricingCopy = await store.createBlock(canvas.id, { title: 'Pricing page copy', content: actualPricingCopy });
      const decision = await store.createBlock(canvas.id, { title: 'Pricing tiers decision', content: actualPricingDecision });
      const rollback = await store.createBlock(canvas.id, { title: 'Rollback runbook', content: '# Rollback runbook\n\n' + actualRollbackBody });
      const copy = await store.createBlock(canvas.id, { title: 'Rollback steps (copy)', content: '# Rollback steps (copy)\n\n' + actualRollbackBody });
      rule = (id, _pair, question) => {
        if (id === 'relation') return 'prerequisite';
        if (question.type !== 'choice') return undefined;
        if (id === 'sourceEvidence') return Object.keys(question.criteria).find(key => question.criteria[key].includes('Still needed:'));
        if (id === 'targetEvidence') return Object.keys(question.criteria).find(key => question.criteria[key].includes('$24'));
        return undefined;
      };
      api = await createApiServer({ dataDir: root, fetcher: (_url, options) => fetch(origin, options) });
      const active = api;
      await new Promise<void>(resolve => active.listen(0, '127.0.0.1', resolve));
      const address = active.address();
      if (!address || typeof address === 'string') throw new Error('Missing actual graph API address');
      const base = `http://127.0.0.1:${address.port}/api`;
      async function request(route: string, method = 'GET', body?: unknown) {
        const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body) });
        expect(response.status).toBe(200); return response.json();
      }
      const prefix = `/canvases/${canvas.id}/jev`;
      await request('/settings', 'PUT', { secrets: { TYPESAFE_API_KEY: 'native-actual-graph' } });
      await request(prefix + '/settings', 'PUT', { externalProcessing: true, modes: { link: 'auto', flag_duplicate: 'auto' } });
      const linked = await request(prefix + '/actions', 'POST', { action: 'link', blockIds: [pricingCopy.id] });
      await expect.poll(async () => ((await request(prefix + '/state')) as JevWorkspaceState).jobs.find(job => job.id === linked.id)?.state,
        { interval: 10 }).toBe('completed');
      const duplicate = await request(prefix + '/actions', 'POST', { action: 'flag_duplicate', blockIds: [rollback.id] });
      await expect.poll(async () => ((await request(prefix + '/state')) as JevWorkspaceState).jobs.find(job => job.id === duplicate.id)?.state,
        { interval: 10 }).toBe('completed');
      const durable = await new JevWorkspaceFiles(root).read(workspace.id);
      expect(durable.jobs.find(job => job.id === duplicate.id)?.result?.findings).toMatchObject([{ method: 'substantive_content', targetId: copy.id }]);
      const proposal = durable.proposals.find(item => item.jobId === duplicate.id)!;
      expect(proposal.mutation.kind).toBe('derived');
      expect(proposal.sources.map(source => source.contentHash)).toEqual([rollback.contentHash, copy.contentHash]);
      expect(await new CanvasStore(root).getCanvasBlock(canvas.id, pricingCopy.id))
        .toMatchObject({ links: [decision.id], linkTypes: { [decision.id]: 'prerequisite' }, content: actualPricingCopy });
      expect((await request(`/canvases/${canvas.id}`)).blocks.map((block: CanvasBlock) => [block.id, block.content]))
        .toEqual([pricingCopy, decision, rollback, copy].map(block => [block.id, block.content]));
    } finally {
      if (api) { const active = api; await new Promise<void>(resolve => active.close(() => resolve())); }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces evidence-backed useful launch links and only the exact runbook duplicate from eight fresh sources', async () => {
    const documents = await launchFixture();
    const before = structuredClone(documents);
    const relations = new Map([
      ['launch-blockers->sso-security-review', 'prerequisite'],
      ['launch-blockers->rollback-runbook', 'prerequisite'],
      ['sso-security-review->pen-test', 'prerequisite'],
      ['pricing-copy->pricing-decision', 'implements'],
    ]);
    rule = (id, pair) => {
      const relation = relations.get(`${pair.source.id}->${pair.target.id}`);
      if (id === 'supported') return relation ? 0.98 : 0.02;
      if (id === 'relation') return relation ?? 'none';
      return undefined;
    };
    const input = context(documents);
    input.retrievedNeighbors = { 'canvas:pricing-copy': ['canvas:pricing-decision'] };
    const linked = await evaluateJevAction(input, action('link', documents.map(item => item.block.id)));
    expect(linked.result.edges).toHaveLength(4);
    expect(linked.result.edges).toEqual(expect.arrayContaining([...relations].map(([key, relation]) => {
      const [sourceId, targetId] = key.split('->');
      return { sourceId, targetId, targetCanvasId: 'canvas', relation, confidence: 0.98, usefulness: 2 };
    })));
    expect(sourcePatch(linked, 'launch-blockers').links).toEqual(expect.arrayContaining(['sso-security-review', 'rollback-runbook']));
    expect(sourcePatch(linked, 'pricing-copy')).toEqual({ links: ['pricing-decision'], linkTypes: { 'pricing-decision': 'implements' } });
    rule = id => id === 'supported' ? 0.02 : undefined;
    const duplicates = await evaluateJevAction(input, action('flag_duplicate', documents.map(item => item.block.id)));
    expect(duplicates.result.findings).toEqual([{ kind: 'duplicate', targetCanvasId: 'canvas', targetId: 'rollback-runbook-copy',
      confidence: 1, status: 'detected', method: 'exact_content', overlap: 'copy', calibration: 1 }]);
    expect(duplicates.proposals.every(proposal => proposal.mutation.kind === 'derived')).toBe(true);
    for (const item of [...linked.proposals, ...duplicates.proposals].flatMap(proposal => proposal.evidence)) {
      const source = documents.find(document => document.block.id === item.source.blockId)!;
      expect(source.block.content.slice(item.start, item.end)).toBe(item.quote);
      expect(item.source).toEqual(source.snapshot);
    }
    expect(documents).toEqual(before);
  });

  it('finds a short exact duplicate among eight fresh launch documents without merging sources', async () => {
    const copied = '# Launch\n\nReady.';
    const documents = [
      document('launch', 'canvas', { title: 'Launch brief', content: copied }),
      document('copy', 'canvas', { title: 'Release status', content: copied }),
      document('runbook', 'canvas', { title: 'Deployment runbook', content: 'Launch requires rollback rehearsal before rollout. Release checks depend on the validation plan.' }),
      document('validation', 'canvas', { title: 'Validation plan', content: 'Before launch, exercise rollback rehearsal and verify smoke checks. Record release checks before rollout.' }),
      document('owners', 'canvas', { title: 'Ownership', content: 'Ada owns validation. Ben owns deployment. Notify both after smoke checks.' }),
      document('support', 'canvas', { title: 'Support schedule', content: 'Support staff answer customer questions from nine until five.' }),
      document('invoice', 'canvas', { title: 'Vendor invoice', content: 'Payment for microphones is due in November.' }),
      document('recipe', 'canvas', { title: 'Lunch recipe', content: 'Mix lentils with tomatoes and olive oil.' }),
    ];
    const before = structuredClone(documents);
    rule = id => id === 'supported' ? 0.02 : undefined;
    const result = await evaluateJevAction(context(documents), action('flag_duplicate', documents.map(item => item.block.id)));
    expect(result.result.findings).toEqual([{ kind: 'duplicate', targetCanvasId: 'canvas', targetId: 'copy',
      confidence: 1, status: 'detected', method: 'exact_content', overlap: 'copy', calibration: 1 }]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].mutation).toMatchObject({ kind: 'derived', blockId: 'launch' });
    expect(result.proposals[0].sources.map(source => source.blockId)).toEqual(['launch', 'copy']);
    for (const item of result.proposals[0].evidence) {
      const source = documents.find(document => document.block.id === item.source.blockId)!;
      expect(source.block.content.slice(item.start, item.end)).toBe(item.quote);
      expect(item.source).toEqual(source.snapshot);
    }
    expect(documents).toEqual(before);
  });

  it('limits exact duplicate candidates and protects hidden, excluded, foreign, and same-source endpoints', async () => {
    const content = 'Ready.';
    const source = document('one', 'canvas', { content });
    const archived = document('archived', 'canvas', { content, archived: true });
    const excluded = document('excluded', 'canvas', { content, processingExcluded: true });
    const foreign = document('foreign', 'canvas', { content });
    foreign.snapshot.workspaceId = 'private-workspace';
    const crossCanvas = document('one', 'other', { content });
    const copies = Array.from({ length: 13 }, (_, index) => document(`copy-${index}`, 'canvas', { content }));
    const documents = [source, archived, excluded, foreign, crossCanvas, ...copies];
    const before = structuredClone(documents);
    const result = await pairFinding(context(documents), action('flag_duplicate'));
    expect(result.result.findings).toHaveLength(12);
    expect(result.proposals.map(proposal => proposal.sources[1].blockId)).toEqual(['one', ...copies.slice(0, 11).map(copy => copy.block.id)]);
    expect(result.proposals[0].sources[1].canvasId).toBe('other');
    expect(result.proposals.every(proposal => proposal.mutation.kind === 'derived')).toBe(true);
    expect(requests).toEqual([]);
    expect(documents).toEqual(before);
  });

  it('does not create an evidence-free exact finding for identical hidden source bytes', async () => {
    const content = '<script>const copied = "secret";</script>';
    const result = await evaluateJevAction(context([document('one', 'canvas', { content }),
      document('two', 'canvas', { content })]), action('flag_duplicate'));
    expect(result.proposals).toEqual([]);
    expect(result.result.findings).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('batches only identical endpoint sources and maps exact quotes and confidence back in source order', async () => {
    const documents = [document('one', 'canvas', { links: ['manual'] }), document('two'), document('three', 'other')];
    rule = (id, pair) => id === 'supported' ? (pair.target.id === 'two' ? 0.91 : 0.97)
      : id === 'sourceEvidence' ? 'p1' : undefined;
    const result = await evaluateJevAction(context(documents), { ...action('link', ['one', 'two']), options: { relation: 'implements' } });
    expect(requests).toHaveLength(3);
    expect(pairs()).toEqual(['one->three', 'one->two', 'two->one', 'two->three']);
    expect(requests.reduce((total, body) => total + Object.keys(body.questions).length, 0)).toBe(16);
    for (const body of requests.filter(body => body.state.questionSets)) {
      for (const [id, question] of Object.entries(body.questions)) {
        expect(question.instructions).toContain(`Use only questionSets[${id.split('__')[0]}]`);
      }
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
    const result = await evaluateJevAction(input, { ...action('link'), options: { relation: 'related' } });
    expect(requests).toHaveLength(5);
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

  it('preserves existing local links when adding a twenty-first evidence-backed link', async () => {
    const links = Array.from({ length: 20 }, (_, index) => `manual-${index}`);
    const source = document('one', 'canvas', { links });
    const result = await evaluateJevAction(context([source, document('two')]), action('link'));
    expect(sourcePatch(result, 'one')).toEqual({ links: [...links, 'two'], linkTypes: { two: 'related' } });
    const blocks = [source.block, document('two').block, ...links.map(id => document(id).block)];
    expect(updatedBlock(source.block, sourcePatch(result, 'one'), blocks).links).toEqual([...links, 'two']);
    expect(result.result.edges).toMatchObject([{ targetId: 'two', relation: 'related' }]);
    expect(source.block.links).toEqual(links);
  });

  it('persists the twenty-first graph link through the public API and reads it after storage reload', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'symbi-graph-links-'));
    let api: Server | undefined;
    try {
      const store = new CanvasStore(root); await store.init();
      const workspace = await store.createWorkspace({ name: 'Native graph links' });
      const canvas = await store.createCanvas(workspace.id, { name: 'Evidence-backed links' });
      const manual = Array.from({ length: 20 }, (_, index) => document(`manual-${index}`, canvas.id,
        { title: `Manual ${index}`, content: `Manual context ${index}.`, file: `docs/manual-${index}.md` }).block);
      // Seed the existing reference documents once so this test measures the graph write and durable readback.
      await Promise.all(manual.map(block => writeFile(path.join(root, block.file), block.content)));
      await writeFile(path.join(root, 'canvases', canvas.id + '.json'), JSON.stringify({ ...canvas, blocks: manual.map(storedBlock) }));
      const source = await store.createBlock(canvas.id, { title: 'Atlas rollout', content: 'Atlas rollout requirements.',
        links: manual.map(block => block.id) });
      const target = await store.createBlock(canvas.id, { title: 'Atlas validation', content: 'Atlas rollout validation requirements.' });
      const input = context([source, target].map(block => ({ canvasId: canvas.id, block,
        snapshot: sourceSnapshot(workspace.id, canvas.id, block) })));
      input.workspaceId = workspace.id; input.canvases = [{ id: canvas.id, name: canvas.name }];
      const result = await evaluateJevAction(input, { action: 'link', canvasId: canvas.id, blockIds: [source.id] });
      const patch = sourcePatch(result, source.id);
      api = await createApiServer({ dataDir: root });
      const active = api;
      await new Promise<void>(resolve => active.listen(0, '127.0.0.1', resolve));
      const address = active.address();
      if (!address || typeof address === 'string') throw new Error('Missing graph API address');
      const url = `http://127.0.0.1:${address.port}/api/canvases/${canvas.id}/blocks/${source.id}`;
      const saved = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-symbiknow-actor': 'Browser' },
        body: JSON.stringify({ ...patch, expectedContentHash: source.contentHash }) });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ links: [...manual.map(block => block.id), target.id], linkTypes: { [target.id]: 'related' } });
      expect(await (await fetch(url)).json()).toMatchObject({ links: [...manual.map(block => block.id), target.id] });
      expect(await new CanvasStore(root).getCanvasBlock(canvas.id, source.id))
        .toMatchObject({ links: [...manual.map(block => block.id), target.id], linkTypes: { [target.id]: 'related' }, content: source.content });
    } finally {
      if (api) { const active = api; await new Promise<void>(resolve => active.close(() => resolve())); }
      await rm(root, { recursive: true, force: true });
    }
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

  it.each(['flag_duplicate'] as const)('isolates %s endpoint pairs after symmetric deduplication without changing their direction', async actionName => {
    const input = context([document('one'), document('two'), document('three'), document('four', 'other')]);
    rule = (id, pair) => id === 'overlap' ? (pair.target.id === 'three' ? 'distinct' : 'copy') : undefined;
    const result = await evaluateJevAction(input, action(actionName, ['one', 'two']));
    expect(requests).toHaveLength(1);
    expect(pairs().sort()).toEqual(['one->four', 'one->three', 'one->two', 'two->four', 'two->three'].sort());
    expect(result.proposals.map(proposal => proposal.sources.map(source => source.blockId))).toEqual([
      ['one', 'four'], ['one', 'two'], ['two', 'four']]);
    expect(result.result.findings).toHaveLength(3);
    expect(result.proposals.every(proposal => proposal.confidence === 1 && proposal.evidence.length === 2)).toBe(true);
  });

  it('rechecks each exact endpoint scope while retaining direction and protecting manual and pinned edges', async () => {
    const source = document('one', 'canvas', { links: ['two', 'three'], linkTypes: { two: 'prerequisite' },
      crossLinks: [{ canvasId: 'other', blockId: 'four', relation: 'implements' }, { canvasId: 'other', blockId: 'five' }],
      jevOwnership: { managed: ['link:canvas:two', 'link:other:four', 'link:other:five'], pins: ['link:other:five'], removedLabels: [], removedLinks: [] } });
    const second = document('two', 'canvas', { links: ['one'] });
    const input = context([source, second, document('three'), document('four', 'other'), document('five', 'other')]);
    rule = (id, pair) => id === 'supported' ? (pair.target.id === 'three' ? 0.61 : pair.source.id === 'two' ? 0.98 : 0.03) : undefined;
    const result = await recheckLinks(input, action('recheck_links', ['one', 'two']));
    expect(requests).toHaveLength(4);
    expect(pairs().sort()).toEqual(['one->two', 'one->three', 'one->four', 'one->five', 'two->one'].sort());
    const hypotheses = requests.flatMap(body => body.state.questionSets ?? [body.state])
      .map(pair => [`${pair.source.id}->${pair.target.id}`, pair.hypothesis]);
    expect(hypotheses).toEqual(expect.arrayContaining([
      ['one->two', 'source depends on target to be understood or carried out'],
      ['one->three', 'target supplies specific useful supporting context when reading source'],
      ['one->four', 'source implements the explicit requirements or plan in target'],
      ['one->five', 'target supplies specific useful supporting context when reading source'],
      ['two->one', 'target supplies specific useful supporting context when reading source']]));
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
    expect(Object.keys(requests[0].questions)).toEqual(['supported', 'sourceEvidence', 'targetEvidence', 'relation']);
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
