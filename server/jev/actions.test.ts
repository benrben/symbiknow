import { validateActionOptions } from './actions/options.js';
import { automaticRecall, automaticVocabulary } from './actions/automatic.js';
import { recheckLinks } from './actions/graph.js';
import { scoreQuality, assignOwner, attachDocToTask } from './actions/work.js';
import { mkdtemp,rm } from 'node:fs/promises';
import { createServer,type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { jevActions,type JevActionRequest,type JevSettings } from '../../shared/jev-types.js';
import type { CanvasBlock,CanvasTask } from '../../shared/types.js';
import { decideWithJev,type JevAnswer,type JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { evaluateJevAction,JEV_QUESTION_VERSION,type JevEvaluationContext,type JevInputDocument } from './actions.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';

type ProviderBody = { model: string; state: Record<string, unknown>; questions: Record<string, JevQuestion> };
let server: Server;
let origin: string;
let requests: ProviderBody[] = [];
let responseStatus = 200;
let transform: (id: string, answer: JevAnswer, body: ProviderBody) => JevAnswer = (_id, answer) => answer;
function questionBodies(id: string): ProviderBody[] {
  return requests.flatMap(body => Object.keys(body.questions).filter(key => key === id || key.endsWith(`__${id}`)).map(key => {
    const batch = /^(\d+)__/.exec(key);
    if (!batch) return body;
    return { ...body, state: (body.state.questionSets as Record<string, unknown>[])[Number(batch[1])],
      questions: Object.fromEntries(Object.entries(body.questions).filter(([wireId]) => wireId.startsWith(`${batch[1]}__`))
        .map(([wireId, question]) => [wireId.replace(/^\d+__/, ''), question])) };
  }));
}
function questionStates(id: string): Record<string, unknown>[] { return questionBodies(id).map(body => body.state); }

function defaultAnswer(id: string, question: JevQuestion, body: ProviderBody): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: id.startsWith('conflict_') ||
    ['unrelatedDeletion', 'unsupportedClaim', 'requirementConflict', 'addressesAi', 'targetStated'].includes(id) ? 0.05 : 0.98 };
  if (question.type === 'score') return { type: 'score', score: question.criteria.length - 1, confidence: 0.98,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === question.criteria.length - 1 ? 1 : 0])) };
  const keys = Object.keys(question.criteria);
  const preferred: Record<string, string> = { existingTask: 'none', role: 'specification', group: 'g1',
    canvas: 'c1', intent: 'organize', impact: 'high' };
  if (id.startsWith('meaning_')) {
    const dates = body.state.dateCandidates as Array<{ passage: string }>;
    preferred[id] = /expires/.test(dates[Number(id.slice(8))].passage) ? 'expiresAt' : 'none';
  }
  const choice = keys.includes(preferred[id]) ? preferred[id] : keys[0];
  return { type: 'choice', choice, confidence: 0.98,
    probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) };
}
beforeAll(async () => {
  server = createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += String(chunk);
    const body = JSON.parse(data) as ProviderBody;
    requests.push(body);
    response.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions)
      .map(([id, question]) => {
        const batch = /^(\d+)__(.*)$/.exec(id);
        if (!batch) return [id, transform(id, defaultAnswer(id, question, body), body)];
        const scoped = { ...body, state: (body.state.questionSets as Record<string, unknown>[])[Number(batch[1])],
          questions: Object.fromEntries(Object.entries(body.questions).filter(([key]) => key.startsWith(`${batch[1]}__`))
            .map(([key, value]) => [key.replace(/^\d+__/, ''), value])) };
        return [id, transform(batch[2], defaultAnswer(batch[2], question, scoped), scoped)];
      })) }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP provider fixture did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => { requests = []; responseStatus = 200; transform = (_id, answer) => answer; });

function block(id: string, overrides: Partial<CanvasBlock> = {}): CanvasBlock {
  return { id, title: `Atlas ${id}`, content: 'Atlas rollout specification.\n- [ ] Enable Atlas pilot by 2026-10-10.\nMaya owns Atlas rollout; Ben reviews.\nAtlas expires on 2026-10-12 and replaces prior rollout.\nEnable Atlas rollout requires completing Atlas pilot first.',
    file: `${id}.md`, kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [],
    group: 'lane:overview', tags: ['atlas'], contentHash: `hash_${id}`, ...overrides };
}
function document(canvasId: string, value: CanvasBlock): JevInputDocument {
  return { canvasId, block: value, snapshot: { workspaceId: 'workspace', canvasId, blockId: value.id,
    incarnation: `inc_${value.id}`, sourceGeneration: 1, contentHash: value.contentHash ?? '', metadataRevision: 1 } };
}
function task(id: string, overrides: Partial<CanvasTask> = {}): CanvasTask {
  return { id, title: `Enable Atlas ${id}`, detail: 'Complete the Atlas pilot and rollout', status: 'todo', blockIds: [],
    acceptanceCriteria: [{ id: 'enabled', text: 'The Atlas pilot feature flag is enabled' }], revision: 2,
    createdBy: 'user', updatedBy: 'user', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', comments: [], ...overrides };
}
function context(): JevEvaluationContext {
  const settings: JevSettings = { paused: false, externalProcessing: true,
    modes: Object.fromEntries(jevActions.map(action => [action, 'auto'])) as JevSettings['modes'],
    people: [{ id: 'maya', name: 'Maya', role: 'Rollout owner' }, { id: 'ben', name: 'Ben', role: 'Reviewer' }], schedules: [] };
  const primary = block('primary', { links: ['secondary'], linkTypes: { secondary: 'prerequisite' } });
  return { workspaceId: 'workspace', documents: [document('canvas', primary),
    document('canvas', block('secondary', { group: 'custom:atlas' })), document('other', block('cross'))],
    canvases: [{ id: 'canvas', name: 'Atlas Workspace', groups: [{ id: 'lane:overview', name: 'Introduction' }, { id: 'custom:atlas', name: 'Atlas rollout', definition: 'Atlas delivery and rollout' }] },
      { id: 'other', name: 'Atlas Delivery' }], tasks: [{ canvasId: 'canvas', task: task('pilot') }, { canvasId: 'canvas', task: task('rollout') }],
    vocabulary: [{ id: 'atlas', kind: 'label', name: 'atlas', definition: 'Atlas product work', aliases: [], state: 'active', version: 1,
      members: [{ canvasId: 'canvas', blockId: 'primary' }] },
      { id: 'rollout', kind: 'label', name: 'rollout', definition: 'Staged deployment work', aliases: [], state: 'active', version: 1, members: [] }],
    settings, apiKey: 'fixture-only-key', now: new Date('2026-10-03T12:00:00Z'),
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions,
      (_url, init) => fetch(`${origin}/v1/systemone`, init), options),
    activity: [{ id: 'receipt', action: 'file', createdAt: '2026-10-03T01:00:00Z', summary: 'Atlas source filed under Atlas',
      sources: [document('canvas', primary).snapshot] }] };
}
function request(action: JevActionRequest['action'], options: JevActionRequest['options'] = {}): JevActionRequest {
  return { action, canvasId: 'canvas', blockIds: ['primary'], query: 'Organize Atlas rollout', options };
}

describe('complete Symbi Reflex action programs through the native SDK and HTTP provider', () => {
  it('files a long diagram document using exact prose beyond its code fence without a singleton subgroup', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'symbi-reflex-diagram-filing-'));
    const store = new CanvasStore(directory); await store.init(); await store.deleteWorkspace('acme-team');
    const workspaceId = (await store.createWorkspace({ name: 'Architecture evidence' })).id;
    const canvasId = (await store.createCanvas(workspaceId, { name: 'Engineering' })).id;
    const purpose = 'Purpose: Engineering / Backend. Define service contracts and persistence.';
    const content = '# Engineering\nArchitecture and delivery guidance.\n````mermaid\n' +
      Array.from({ length: 300 }, (_, index) => `Diagram${index} --> Diagram${index + 1}`).join('\n') +
      '\n~~~\n```\nDiagram body remains fenced.\n````\n   \n---\n|:---|---:|\n' +
      Array.from({ length: 12 }, (_, index) => `Architecture requirement ${index}: service responsibilities are explicit.`).join('\n') +
      '\n## Backend\n  ' + purpose + '  ';
    const source = await store.createBlock(canvasId, { title: 'Architecture', content });
    transform = (id, answer, body) => {
      const question = body.questions[id];
      if (id === 'evidence' && question.type === 'choice') return choiceAnswer(question,
        Object.keys(question.criteria).find(key => question.criteria[key] === purpose) ?? 'none');
      return answer;
    };
    const owner = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true } as const;
    const runtime = new JevRuntime(store, { startTimer: false, evaluate: (context, request) => {
      context.apiKey = 'native-diagram-key'; return evaluateJevAction(context, request);
    }, fetcher: (_url, options) => fetch(origin, options) });
    try {
      await runtime.configure(workspaceId, { externalProcessing: true, modes: { file: 'auto' } as JevSettings['modes'] }, owner);
      const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [source.id] }, owner);
      await runtime.idle();
      const state = await runtime.read(workspaceId, owner);
      expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'completed', result: {
        documents: { [source.id]: { status: 'proposed_grouping', source: { canvasId, blockId: source.id } } } } });
      const membership = state.proposals.find(item => item.jobId === job.id && item.mutation.kind === 'document')!;
      expect(membership.state).toBe('applied');
      expect(membership.evidence[0]).toMatchObject({ quote: purpose, start: content.indexOf(purpose), end: content.indexOf(purpose) + purpose.length });
      expect(membership.decisionConfidences).toEqual([0.98, 0.98, 0.98]);
      expect(await new CanvasStore(directory).getCanvasBlock(canvasId, source.id)).toMatchObject({ content, group: 'custom:engineering' });
      const grouped = questionBodies('group').find(item => item.state.proposedGroups)!;
      const stateSource = grouped.state.source as { passages: Array<{ text: string }> };
      expect(stateSource.passages).toHaveLength(8);
      expect(stateSource.passages[0].text).toBe('# Engineering');
      expect(stateSource.passages.at(-1)?.text).toBe(purpose);
      expect(JSON.stringify(stateSource)).not.toContain('Diagram');
      expect(grouped.state.proposedGroups).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'custom:engineering' })]));
      expect((grouped.state.proposedGroups as Array<{ key: string }>).some(group => group.key.includes('/'))).toBe(false);
    } finally { runtime.close(); await runtime.idle(); await rm(directory, { recursive: true, force: true }); }
  });
  it('retains the actual independent filing outcome and exact source stamp for every selected document', async () => {
    const input = context(); input.vocabulary = [];
    input.documents = [document('canvas', block('unchanged', { group: 'custom:atlas' })),
      document('canvas', block('abstained', { group: undefined })), document('canvas', block('proposed', { group: undefined }))];
    input.canvases[0].groups = [{ id: 'custom:atlas', name: 'Atlas', definition: 'Atlas delivery' }];
    transform = (id, answer, body) => {
      if (id !== 'group') return answer;
      const source = (body.state.document ?? body.state.source) as { id: string };
      return choiceAnswer(body.questions[id], source.id === 'abstained' ? 'none' : 'g0');
    };
    const result = await evaluateJevAction(input, { action: 'file', canvasId: 'canvas' });
    expect(result.result.documents).toEqual({ unchanged: { status: 'no_change', source: input.documents[0].snapshot },
      abstained: { status: 'insufficient_group_evidence', source: input.documents[1].snapshot },
      proposed: { status: 'proposed', source: input.documents[2].snapshot } });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].mutation).toMatchObject({ blockId: 'proposed', patch: { group: 'custom:atlas' } });
  });
  it.each(jevActions)('evaluates %s using real scoped source state', async action => {
    const input = context();
    if (action === 'flag_duplicate') input.documents[1].block.content += '\nA distinct revision note.';
    const options: JevActionRequest['options'] = {};
    const result = await evaluateJevAction(input, request(action, options));
    expect(result.result).toBeTypeOf('object');
    expect(Array.isArray(result.proposals)).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    for (const proposal of result.proposals) {
      expect(proposal.action).toBe(action);
      for (const passage of proposal.evidence) {
        const source = input.documents.find(document => document.canvasId === passage.source.canvasId && document.block.id === passage.source.blockId);
        expect(source?.block.content.slice(passage.start, passage.end)).toBe(passage.quote);
        expect(passage.source.sourceGeneration).toBe(1);
      }
    }
    expect(input.documents[0].block.archived).toBeUndefined();
    expect(requests.every(body => body.model === 'jev-1.13.0')).toBe(true);
  });

  it.each(['file', 'label', 'suggest_home_canvas', 'link', 'flag_duplicate'] as const)('uses the saved threshold for %s semantic decisions', async action => {
    transform = (_id, answer, body) => {
      if (answer.type === 'noul') return { type: 'noul', noul: 0.75 };
      if (answer.type !== 'choice') return answer;
      const keys = Object.keys(body.questions[_id].type === 'choice' ? (body.questions[_id] as Extract<JevQuestion, { type: 'choice' }>).criteria : {});
      if (_id.toLowerCase().includes('evidence')) return { ...answer, confidence: 0.2 };
      return { ...answer, confidence: 0.75,
        probabilities: Object.fromEntries(keys.map(key => [key, key === answer.choice ? 0.75 : key === 'unknown' ? 0.25 : 0])) };
    };
    const results = [];
    for (const threshold of [0.65, 0.85, undefined]) {
      const input = context();
      if (action === 'flag_duplicate') {
        input.documents[1].block.content += '\nA distinct revision note.';
        input.documents[2].block.content += '\nA distinct delivery note.';
      }
      input.settings.confidenceThresholds = threshold === undefined ? undefined : { [action]: threshold };
      results.push(await evaluateJevAction(input, request(action)));
      expect(input.documents[0].block.group).toBe('lane:overview');
    }
    expect(results[0].proposals.length).toBeGreaterThan(0);
    expect(results[1].proposals).toEqual([]);
    expect(results[2].proposals).toEqual(results[0].proposals);
  });

  it.each([0.65, 0.85])('retains uncertain profile, quality and link diagnostics under their action cutoff (%s)', async threshold => {
    const input = context(); input.settings.confidenceThresholds = { profile: threshold }; input.confidenceThreshold = threshold;
    transform = (id, answer) => {
      if (answer.type === 'noul') return { type: 'noul', noul: 0.75 };
      if (answer.type === 'score') return { ...answer, confidence: 0.75 };
      if (id === 'keyPassage' || id.toLowerCase().includes('evidence')) return { ...answer, confidence: 0.2 };
      return { ...answer, confidence: 0.75 };
    };
    const profile = await evaluateJevAction(input, request('profile'));
    expect(profile.proposals).toHaveLength(1);
    expect(profile.result.documents).toMatchObject({ primary: { role: threshold < 0.75 ? 'specification' : 'unknown',
      keyPassages: ['Atlas rollout specification.'], keyPassageSelectionConfidence: 0.2 } });
    const quality = await scoreQuality(input, request('score_quality'));
    expect(quality.proposals).toHaveLength(1);
    const rubric = (quality.result.documents as Record<string, { rubric: Record<string, unknown> }>).primary.rubric;
    expect(rubric.specificity).toEqual(threshold < 0.75 ? { score: 3, confidence: 0.75 }
      : { score: 3, confidence: 0.75, status: 'uncertain' });
    const links = await recheckLinks(input, request('recheck_links'));
    expect(links.result.edges).toMatchObject([{ status: threshold < 0.75 ? 'fresh' : 'insufficient_evidence', confidence: 0.75 }]);
    expect(links.proposals).toHaveLength(1);
    const recall = await automaticRecall(input, request('recall'));
    expect(recall.result.evidenceFound).toBe(threshold < 0.75);
    expect((recall.result.passages as unknown[]).length).toBeGreaterThan(0);
    expect((recall.result.conflicts as unknown[]).length > 0).toBe(threshold < 0.75);
  });

  it.each([0.65, 0.85])('requires the configured negative confidence and exact management before removing links (%s)', async threshold => {
    const input = context(); input.confidenceThreshold = threshold;
    input.documents[0].block.jevOwnership = { managed: ['link:canvas:secondary'], pins: [], removedLabels: [], removedLinks: [] };
    transform = (id, answer) => id === 'supported' ? { type: 'noul', noul: 0.25 } : answer;
    const result = await recheckLinks(input, request('recheck_links'));
    const removals = result.proposals.filter(proposal => proposal.mutation.kind === 'document');
    expect(removals).toHaveLength(threshold < 0.75 ? 1 : 0);
    expect(input.documents[0].block.links).toEqual(['secondary']);
    input.documents[0].block.jevOwnership.pins = ['link:canvas:secondary'];
    expect((await recheckLinks(input, request('recheck_links'))).proposals
      .filter(proposal => proposal.mutation.kind === 'document')).toEqual([]);
  });

  it('keeps a managed link when a minimum-threshold tie is accepted as supporting its existing relation', async () => {
    const input = context(); input.confidenceThreshold = 0.5;
    input.documents[0].block.jevOwnership = { managed: ['link:canvas:secondary'], pins: [], removedLabels: [], removedLinks: [] };
    transform = (id, answer) => id === 'supported' ? { type: 'noul', noul: 0.5 } : answer;
    const result = await recheckLinks(input, request('recheck_links'));
    expect(result.result.edges).toMatchObject([{ status: 'fresh' }]);
    expect(result.proposals.filter(proposal => proposal.mutation.kind === 'document')).toEqual([]);
  });

  it('recognizes known entities and activated groups', async () => {
    const input = context();
    input.vocabulary.push({ id: 'atlas_entity', kind: 'entity', name: 'Atlas', definition: 'Atlas product',
      state: 'active', aliases: [], version: 1, members: [] }, { id: 'delivery_group', kind: 'group', name: 'Delivery',
      definition: 'Atlas delivery work', state: 'active', aliases: [], version: 1, members: [] });
    const profile = await evaluateJevAction(input, request('profile'));
    expect(JSON.stringify(profile.result.documents)).toContain('atlas_entity');
    await evaluateJevAction(input, request('file'));
    expect(JSON.stringify(questionBodies('group').at(-1)?.questions.group)).toContain('Delivery');
  });

  it('uses native group keys for activated terms and explicit rename and merge migrations', async () => {
    const input = context();
    input.documents[0].block.group = 'custom:delivery';
    input.documents[1].block.group = 'custom:pinned_manually';
    input.vocabulary.push({ id: 'delivery', kind: 'group', name: 'Delivery', definition: 'Atlas delivery work',
      state: 'active', aliases: [], version: 1, members: [{ canvasId: 'canvas', blockId: 'primary' },
        { canvasId: 'canvas', blockId: 'secondary' }] },
    { id: 'product_group', kind: 'group', name: 'Product Delivery', definition: 'Atlas delivery work',
      state: 'active', aliases: [], version: 1, members: [] });
    transform = (id, answer, body) => {
      const question = body.questions[id];
      if (id !== 'group' || question.type !== 'choice') return answer;
      return choiceAnswer(question, Object.keys(question.criteria).find(key => question.criteria[key].includes('Product Delivery')) ?? 'none');
    };
    const filed = await evaluateJevAction(input, request('file'));
    expect(filed.proposals[0].mutation).toMatchObject({ patch: { group: 'custom:product_delivery' } });
    const renamed = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'rename', termId: 'delivery', name: 'Release Work' }));
    expect(renamed.proposals.filter(proposal => proposal.mutation.kind === 'document').map(proposal => proposal.mutation))
      .toEqual([{ kind: 'document', canvasId: 'canvas', blockId: 'primary', patch: { group: 'custom:release_work' } }]);
    const merged = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'merge', termId: 'delivery', targetId: 'product_group' }));
    expect(merged.proposals.filter(proposal => proposal.mutation.kind === 'document')[0].mutation)
      .toMatchObject({ patch: { group: 'custom:product_delivery' } });
  });

  it('bootstraps checked native groups and subgroups from source headings with one guard per membership', async () => {
    const input = context();
    input.documents = input.documents.slice(0, 2);
    input.documents.forEach(document => { delete document.block.group; document.block.content = '# Atlas\n## Rollout\nAtlas rollout requires pilot acceptance.'; });
    input.canvases[0].groups = []; input.vocabulary = [];
    transform = (id, answer, body) => id === 'group' ? groupAnswer(body.questions[id], 'custom:atlas/rollout') : answer;
    const result = await evaluateJevAction(input, { ...request('file'), blockIds: ['primary', 'secondary'] });
    const definitions = result.proposals.filter(proposal => proposal.mutation.kind === 'vocabulary');
    const memberships = result.proposals.filter(proposal => proposal.mutation.kind === 'document');
    expect(definitions).toHaveLength(2);
    expect(definitions[0].mutation).toMatchObject({ term: { groupKey: 'custom:atlas', members: [
      { canvasId: 'canvas', blockId: 'primary' }, { canvasId: 'canvas', blockId: 'secondary' }] } });
    if (definitions[0].mutation.kind !== 'vocabulary') throw new Error('Expected parent definition');
    expect(definitions[1].mutation).toMatchObject({ term: { groupKey: 'custom:atlas/rollout', parentId: definitions[0].mutation.term.id } });
    expect(memberships).toHaveLength(2);
    expect(memberships.every(proposal => proposal.sources.length === 1 && proposal.confidence === undefined)).toBe(true);
    expect(memberships.every(proposal => JSON.stringify(proposal.decisionConfidences) === JSON.stringify([0.97, 0.98, 0.98, 0.98]))).toBe(true);
    expect(definitions[0].decisionConfidences).toEqual([0.97, 0.98, 0.98, 0.98, 0.97, 0.98, 0.98, 0.98]);
    expect(result.proposals.slice(0, 2).every(proposal => proposal.mutation.kind === 'vocabulary')).toBe(true);
    expect(memberships.map(proposal => proposal.mutation)).toMatchObject([
      { blockId: 'primary', patch: { group: 'custom:atlas/rollout' } }, { blockId: 'secondary', patch: { group: 'custom:atlas/rollout' } }]);
    expect(input.documents[0].block.group).toBeUndefined();
  });

  it('uses a scoped canvas topic catalog to share semantic groups across six differently titled documents', async () => {
    const input = context(); input.canvases[0].groups = []; input.vocabulary = []; input.settings.modes.file = 'auto';
    const topics = [
      ['Architecture overview', '# Engineering\n## Backend\nPurpose: Engineering / Backend. Service architecture and API contracts.'],
      ['REST endpoint conventions', '# REST endpoint conventions\nPurpose: Engineering / Backend. Define backend service endpoints.'],
      ['Database data model', '# Database data model\nPurpose: Engineering / Backend. Define backend persistence schemas.'],
      ['Browser application overview', '# Engineering\n## Frontend\nPurpose: Engineering / Frontend. Browser application architecture.'],
      ['React component patterns', '# React component patterns\nPurpose: Engineering / Frontend. Component composition and rendering.'],
      ['Navigation behavior', '# Navigation behavior\nPurpose: Engineering / Frontend. Browser route transitions and accessibility.'],
    ];
    input.documents = topics.map(([title, content], index) => document('canvas', block(`topic${index}`, { title, content, group: undefined, tags: [] })));
    input.documents.push(document('other', block('private', { content: '# PRIVATE REMOTE TOPIC\n## Hidden', group: undefined, tags: [] })),
      document('canvas', block('excluded', { content: '# PRIVATE EXCLUDED TOPIC\n## Hidden', group: undefined, tags: [], processingExcluded: true })),
      document('canvas', block('archived', { content: '# PRIVATE ARCHIVED TOPIC\n## Hidden', group: undefined, tags: [], archived: true })));
    transform = (id, answer, body) => {
      const question = body.questions[id];
      const source = (body.state.source ?? body.state.document) as { passages: Array<{ id: string; text: string }> };
      if (id === 'group' && question.type === 'choice') {
        const topic = source.passages.some(passage => passage.text.includes('Engineering / Backend')) ? 'custom:engineering/backend' : 'custom:engineering/frontend';
        return choiceAnswer(question, Object.keys(question.criteria).find(key => question.criteria[key].includes(`(${topic})`)) ?? 'none');
      }
      if (id === 'evidence' && question.type === 'choice') return choiceAnswer(question, source.passages.find(passage => passage.text.startsWith('Purpose:'))!.id);
      return answer;
    };
    const result = await evaluateJevAction(input, { action: 'file', canvasId: 'canvas', blockIds: topics.map((_, index) => `topic${index}`) });
    const definitions = result.proposals.filter(proposal => proposal.mutation.kind === 'vocabulary');
    const memberships = result.proposals.filter(proposal => proposal.mutation.kind === 'document');
    expect(definitions.map(proposal => proposal.mutation.kind === 'vocabulary' && proposal.mutation.term.groupKey))
      .toEqual(['custom:engineering', 'custom:engineering/backend', 'custom:engineering/frontend']);
    expect(memberships).toHaveLength(6);
    expect(memberships.map(proposal => proposal.mutation.kind === 'document' && proposal.mutation.patch.group))
      .toEqual([...Array.from({ length: 3 }, () => 'custom:engineering/backend'), ...Array.from({ length: 3 }, () => 'custom:engineering/frontend')]);
    expect(memberships.every(proposal => proposal.sources.length === 1 && proposal.evidence[0].quote.startsWith('Purpose:')
      && proposal.decisionConfidences?.length === 4 && proposal.decisionConfidences.every(value => value >= 0.95))).toBe(true);
    expect(definitions.every(proposal => proposal.sources.every(source => source.canvasId === 'canvas'))).toBe(true);
    expect(definitions.some(proposal => proposal.evidence.some(passage => passage.source.blockId === 'topic0' && passage.quote === '## Backend'))).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('PRIVATE');
    const catalogs = questionBodies('group').filter(body => Array.isArray(body.state.proposedGroups));
    expect(catalogs).toHaveLength(6);
    const rankedKeys = (catalogs[0].state.proposedGroups as Array<{ key: string }>).slice(0, 3).map(group => group.key);
    expect(rankedKeys[0]).toBe('custom:engineering');
    expect(new Set(rankedKeys)).toEqual(new Set(['custom:engineering', 'custom:engineering/backend', 'custom:engineering/frontend']));
    expect(result.proposals.slice(0, 3).every(proposal => proposal.mutation.kind === 'vocabulary')).toBe(true);
  });

  it('requires independent local purpose and subgroup containment even when neighbor candidates are confident', async () => {
    const input = context(); input.documents = input.documents.slice(0, 2); input.vocabulary = []; input.canvases[0].groups = [];
    input.documents.forEach(document => { document.block.group = undefined; document.block.tags = [];
      document.block.content = '# Atlas\n## Rollout\nAtlas rollout planning belongs to Atlas product delivery.'; });
    input.settings.modes.file = 'auto';
    transform = (id, answer, body) => id === 'group' ? choiceAnswer(body.questions[id], 'unknown') : answer;
    expect(await evaluateJevAction(input, request('file'))).toMatchObject({ result: { status: 'insufficient_group_evidence' }, proposals: [] });
    transform = (id, answer) => id === 'coherent' ? { type: 'noul', noul: 0.1 } : answer;
    expect(await evaluateJevAction(input, request('file'))).toMatchObject({ result: { status: 'insufficient_group_evidence' }, proposals: [] });
    transform = (id, answer, body) => id === 'evidence' ? choiceAnswer(body.questions[id], 'none') : answer;
    expect(await evaluateJevAction(input, request('file'))).toMatchObject({ result: { status: 'insufficient_group_evidence' }, proposals: [] });
    transform = (id, answer) => /^purpose(?:_\d+)?$/.test(id) ? { type: 'noul', noul: 0.1 } : answer;
    expect(await evaluateJevAction(input, request('file'))).toMatchObject({ result: { status: 'insufficient_local_group_purpose' }, proposals: [] });
    transform = (id, answer, body) => {
      if (id === 'group') return groupAnswer(body.questions[id], 'custom:atlas/rollout', true);
      return /^containment(?:_\d+)?$/.test(id) ? { type: 'noul', noul: 0.1 } : answer;
    };
    const broader = await evaluateJevAction(input, request('file'));
    expect(broader.proposals.find(proposal => proposal.mutation.kind === 'document')?.mutation).toMatchObject({ patch: { group: 'custom:atlas' } });
    transform = (id, answer, body) => {
      if (id === 'group') return groupAnswer(body.questions[id], 'custom:atlas/rollout');
      return /^purpose(?:_\d+)?$/.test(id) ? { type: 'noul', noul: 0.85 } : answer;
    };
    const uncertain = await evaluateJevAction(input, request('file'));
    expect(uncertain.proposals).toHaveLength(3);
    expect(uncertain.proposals.every(proposal => JSON.stringify(proposal.decisionConfidences) === '[0.97,0.98,0.85,0.98]')).toBe(true);
    input.canvases[0].groups = [{ id: 'custom:atlas/rollout', name: 'Atlas / Rollout', definition: 'Atlas product delivery and rollout planning' }];
    transform = (id, answer) => /^purpose(?:_\d+)?$/.test(id) ? { type: 'noul', noul: 0.1 } : answer;
    expect((await evaluateJevAction(input, request('file'))).proposals).toEqual([]);
    transform = (id, answer) => /^containment(?:_\d+)?$/.test(id) ? { type: 'noul', noul: 0.1 } : answer;
    const parentFallback = await evaluateJevAction(input, request('file'));
    expect(parentFallback.proposals.find(proposal => proposal.mutation.kind === 'document')?.mutation)
      .toMatchObject({ patch: { group: 'custom:atlas' } });
    expect(parentFallback.proposals.every(proposal => proposal.decisionConfidences?.length === 3)).toBe(true);
    transform = (id, answer, body) => {
      if (id === 'group') return groupAnswer(body.questions[id], 'custom:atlas/rollout');
      return /^purpose(?:_\d+)?$/.test(id) ? { type: 'noul', noul: 0.85 } : answer;
    };
    expect((await evaluateJevAction(input, request('file'))).proposals[0].decisionConfidences).toEqual([0.97, 0.85, 0.98]);
  });

  it.each([0.7, 0.69])('checks local purpose independently when two valid filing passages split their probability (purpose=%s)', async purpose => {
    const input = context(); input.documents = input.documents.slice(0, 1); input.vocabulary = [];
    const source = input.documents[0]; source.block.group = undefined; source.block.tags = [];
    source.block.title = 'Agent integration';
    source.block.content = '<body><p>AI &amp; agents · MCP</p><h1>Agent integration</h1>' +
      '<p>Agents read shared sources through authenticated MCP transports.</p></body>';
    input.canvases[0].groups = [{ id: 'custom:ai_agents', name: 'AI & agents', definition: 'AI assistants and agent integration' }];
    transform = (id, answer, body) => {
      const question = body.questions[id];
      if (id === 'group') return groupAnswer(question, 'custom:ai_agents');
      if (/^purpose(?:_\d+)?$/.test(id)) return { type: 'noul', noul: purpose };
      if (id !== 'evidence' || question.type !== 'choice') return answer;
      return { type: 'choice', choice: 'p0', confidence: 0.96,
        probabilities: { ...Object.fromEntries(Object.keys(question.criteria).map(key => [key, 0])), p0: 0.5, p1: 0.44, none: 0.06 } };
    };
    const result = await evaluateJevAction(input, request('file'));
    const checked = questionBodies('purpose_0');
    expect(checked.length).toBeGreaterThan(0);
    expect((checked[0].state.localEvidence as unknown[])[0]).toEqual({
      start: source.block.content.indexOf('AI &amp; agents · MCP'),
      end: source.block.content.indexOf('AI &amp; agents · MCP') + 'AI &amp; agents · MCP'.length, quote: 'AI &amp; agents · MCP' });
    expect(checked[0].questions.purpose_0.instructions).toContain('Use only localEvidence[0]');
    if (purpose < 0.7) {
      expect(result.proposals).toEqual([]);
      return;
    }
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].mutation).toMatchObject({ blockId: source.block.id, patch: { group: 'custom:ai_agents' } });
    expect(result.proposals[0].decisionConfidences).toEqual([0.97, 0.7]);
    expect(source.block.group).toBeUndefined();
  });

  it.each([false, true])('retains a late requested member’s main topic when neighboring headings exhaust the catalog (archived=%s)', async archived => {
    const input = context(); input.vocabulary = []; input.canvases[0].groups = [];
    input.documents = Array.from({ length: 40 }, (_, index) => document('canvas', block(`crowded${index}`, {
      title: `Guide ${index}`, group: undefined, tags: [], content: `# Guide ${index}\n` + Array.from({ length: 12 }, (_, section) =>
        `## Section ${index}.${section}\nSpecific guidance for section ${section}.`).join('\n'),
    })));
    const member = input.documents[39]; member.block.title = 'Agent Integration';
    member.block.archived = archived;
    member.block.content = '# Agent Integration\nExternal agents share the canvas through authenticated transports.\n' +
      Array.from({ length: 12 }, (_, index) => `## Agent section ${index}\nDetails for agent section ${index}.`).join('\n');
    transform = (id, answer, body) => {
      const question = body.questions[id];
      if (id === 'group' && question.type === 'choice') return choiceAnswer(question,
        Object.keys(question.criteria).find(key => question.criteria[key].includes('(custom:agent_integration)')) ?? 'none');
      if (id === 'evidence' && question.type === 'choice') return choiceAnswer(question, 'p1');
      return answer;
    };
    const result = await evaluateJevAction(input, { action: 'file', canvasId: 'canvas', blockIds: [member.block.id] });
    expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')?.mutation)
      .toMatchObject({ blockId: member.block.id, patch: { group: 'custom:agent_integration' } });
    const catalog = questionStates('group').find(state => Array.isArray(state.proposedGroups))!.proposedGroups as Array<{ key: string }>;
    expect(catalog.map(group => group.key)).toEqual(['custom:agent_integration']);
    expect(catalog.some(group => group.key.startsWith('custom:guide_'))).toBe(false);
    expect(result.proposals.every(proposal => JSON.stringify(proposal.sources) === JSON.stringify([member.snapshot]))).toBe(true);
  });

  it('tries independently checked source topics after an existing group lacks its own placement evidence', async () => {
    const input = context(); input.documents = input.documents.slice(0, 1); input.vocabulary = [];
    input.documents[0].block.group = undefined; input.documents[0].block.tags = [];
    input.documents[0].block.content = '# Engineering\n## Backend\nPurpose: Engineering / Backend. Define service contracts.';
    input.canvases[0].groups = [{ id: 'custom:cuisine', name: 'Cuisine', definition: 'Cooking and recipes' }];
    transform = (id, answer, body) => {
      const question = body.questions[id];
      if (id === 'group' && question.type === 'choice') return choiceAnswer(question,
        Object.keys(question.criteria).find(key => question.criteria[key].includes('(custom:engineering)')) ?? Object.keys(question.criteria)[0]);
      if (id === 'evidence' && question.type === 'choice') return choiceAnswer(question,
        (body.state.selectedGroup as { key: string }).key === 'custom:cuisine' ? 'none' : 'p2');
      return answer;
    };
    const result = await evaluateJevAction(input, request('file'));
    expect(result.proposals.find(proposal => proposal.mutation.kind === 'document')?.mutation).toMatchObject({ patch: { group: 'custom:engineering' } });
    expect(questionStates('purpose_0').some(state => (state.selectedGroup as { key: string }).key === 'custom:cuisine')).toBe(true);
    expect(result.proposals.every(proposal => proposal.decisionConfidences?.every(value => value >= 0.95))).toBe(true);
  });

  it('supplies selected identities and definitions before dependent judgments reach the native provider', async () => {
    const dimensions = ['specificity', 'traceability', 'declaredPurposeCompleteness', 'internalConsistency'];
    transform = (id, answer, body) => {
      const question = body.questions[id]; const state = body.state;
      if (id === 'coherent') return { type: 'noul', noul: (state.selectedGroup as { name?: string; key?: string })?.name
        && (state.selectedGroup as { key?: string }).key ? 0.98 : 0.01 };
      if (id === 'fit') return { type: 'noul', noul: (state.selectedConcept as { name?: string })?.name ? 0.98 : 0.01 };
      if (id === 'containment' && state.childName) return { type: 'noul', noul: (state.selectedParent as { id?: string; definition?: string })?.id
        && (state.selectedParent as { definition?: string }).definition ? 0.98 : 0.01 };
      if (question.type === 'score') return { type: 'score', score: 2.5, confidence: 0.98, probabilities: { '0': 0, '1': 0, '2': 0.5, '3': 0.5 } };
      if (id === 'person' && question.type === 'choice' && question.instructions.includes('reviewing')) return choiceAnswer(question, 'person1');
      if (question.type !== 'choice') return answer;
      const instruction = question.instructions;
      const ownerEvidence = /^evidence_(\d+)$/.exec(id);
      if (ownerEvidence) {
        const people = state.people as Array<{ id: string; name: string; role: string }>;
        return choiceAnswer(question, people?.[Number(ownerEvidence[1])] && state.assignment && state.task ? 'p2' : 'none');
      }
      if (id === 'evidence') {
        let available = true;
        if (/placement|grouping|selectedGroup/.test(instruction)) available = !!state.selectedGroup;
        if (/home canvas|selectedCanvas/.test(instruction)) available = !!state.selectedCanvas;
        if (/assigns/.test(instruction)) available = !!state.selectedPerson;
        if (/priority impact|selectedPriority/.test(instruction)) available = !!state.selectedPriority;
        if (!available) return choiceAnswer(question, 'none');
      }
      const dimension = dimensions.find(dimension => id === `${dimension}Evidence`);
      if (dimension && !(state.assessments as Record<string, unknown>)?.[dimension]) return choiceAnswer(question, 'none');
      return answer;
    };
    const bootstrap = context(); bootstrap.vocabulary = []; bootstrap.canvases[0].groups = []; bootstrap.documents = bootstrap.documents.slice(0, 1);
    bootstrap.documents[0].block = { ...bootstrap.documents[0].block, group: undefined, tags: [],
      content: '# Atlas\n## Rollout\nAtlas rollout planning belongs to Atlas product delivery.' };
    const grouping = await evaluateJevAction(bootstrap, request('file'));
    expect(grouping.proposals.find(proposal => proposal.mutation.kind === 'document')?.mutation).toMatchObject({ patch: { group: 'custom:atlas' } });
    const coherence = questionBodies('coherent')[0];
    expect(coherence.state.selectedGroup).toMatchObject({ name: 'Atlas', key: 'custom:atlas', definition: '# Atlas' });
    expect(questionBodies('group')[0].questions).not.toHaveProperty('coherent');
    expect(questionBodies('group')[0].questions).not.toHaveProperty('evidence');
    requests = [];
    const filing = await evaluateJevAction(context(), request('file'));
    expect(filing.proposals[0].mutation).toMatchObject({ patch: { group: 'custom:atlas' } });
    expect(questionStates('evidence')[0].selectedGroup).toMatchObject({ key: 'custom:atlas', name: 'Atlas rollout', definition: 'Atlas delivery and rollout' });
    requests = [];
    const vocabulary = context(); vocabulary.vocabulary.push({ id: 'atlas-parent', kind: 'group', name: 'Atlas', groupKey: 'custom:atlas',
      definition: 'Atlas product delivery', aliases: [], state: 'active', version: 1, members: [] });
    const defined = await automaticVocabulary(vocabulary, request('vocab_lifecycle', { operation: 'define', kind: 'group', name: 'Pilot', definition: 'Atlas pilot delivery' }));
    expect(defined.proposals[0].mutation).toMatchObject({ term: { groupKey: 'custom:atlas/pilot', parentId: 'atlas-parent' } });
    expect(requests.find(body => body.questions.fit)!.state.selectedConcept).toEqual({ name: 'Pilot', kind: 'group', definition: 'Atlas pilot delivery',
      nameOrigin: 'supplied_name', definitionBasis: 'supplied_definition' });
    expect(questionStates('containment').map(state => state.selectedParent)).toEqual([
      { id: 'atlas-parent', name: 'Atlas', definition: 'Atlas product delivery', groupKey: 'custom:atlas' },
    ]);
    expect(requests.find(body => body.questions.concept)!.questions).not.toHaveProperty('fit');
    expect(questionStates('parent')).toHaveLength(1);
    expect(questionStates('parent')[0].parentCandidates).toEqual([
      { id: 'atlas-parent', name: 'Atlas', definition: 'Atlas product delivery', groupKey: 'custom:atlas' },
    ]);
    requests = [];
    expect((await evaluateJevAction(context(), request('suggest_home_canvas'))).proposals[0].mutation).toMatchObject({ targetCanvasId: 'other' });
    expect(requests.find(body => body.questions.evidence)!.state.selectedCanvas).toMatchObject({ id: 'other', name: 'Atlas Delivery', description: expect.stringContaining('Atlas Delivery') });
    requests = [];
    expect((await assignOwner(context(), request('assign_owner'))).proposals[0].mutation).toMatchObject({ patch: { assignee: 'maya' } });
    expect(questionStates('evidence_0').map(state => (state.people as Array<unknown>)[0])).toEqual([
      expect.objectContaining({ id: 'maya', name: 'Maya', role: 'Rollout owner' }),
      expect.objectContaining({ id: 'maya', name: 'Maya', role: 'Rollout owner' }),
    ]);
    requests = [];
    expect((await assignOwner(context(), request('assign_owner', { subaction: 'assign_reviewer' }))).proposals[0].mutation).toMatchObject({ patch: { reviewer: 'ben' } });
    expect(questionStates('evidence_1').map(state => (state.people as Array<unknown>)[1])).toEqual([
      expect.objectContaining({ id: 'ben', name: 'Ben', role: 'Reviewer' }),
      expect.objectContaining({ id: 'ben', name: 'Ben', role: 'Reviewer' }),
    ]);
    requests = [];
    const quality = await scoreQuality(context(), request('score_quality'));
    expect(quality.proposals[0].mutation).toMatchObject({ values: { qualityRubric: { specificity: { score: 2.5 } } } });
    expect(requests.find(body => body.questions.specificityEvidence)!.state.assessments).toMatchObject({ specificity: {
      score: 2.5, scale: ['Insufficient evidence', 'Substantial gaps', 'Partly supported', 'Well supported'] } });
    expect(requests.find(body => body.questions.specificity)!.questions).not.toHaveProperty('specificityEvidence');
  });

  it('keeps a selected home or responsible person unchanged when no exact supporting passage is selected', async () => {
    transform = (id, answer, body) => /^evidence(?:_\d+)?$/.test(id) ? choiceAnswer(body.questions[id], 'none') : answer;
    expect((await evaluateJevAction(context(), request('suggest_home_canvas'))).proposals).toEqual([]);
    expect((await assignOwner(context(), request('assign_owner'))).proposals).toEqual([]);
    expect(questionStates('evidence')).toHaveLength(1);
    expect(questionStates('evidence').every(state => state.selectedCanvas)).toBe(true);
    expect(questionStates('evidence_0')).toHaveLength(2);
    expect(questionStates('evidence_1').every(state => state.people && state.assignment && state.task)).toBe(true);
  });

  it('automatically creates a checked shared taxonomy for six new sources beyond an unrelated active group', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'symbi-reflex-new-topic-'));
    const store = new CanvasStore(directory); await store.init(); await store.deleteWorkspace('acme-team');
    const workspaceId = (await store.createWorkspace({ name: 'Mixed taxonomy' })).id;
    const canvasId = (await store.createCanvas(workspaceId, { name: 'Engineering and reference' })).id;
    const original = await store.createBlock(canvasId, { title: 'Recipe reference', content: '# Cuisine\nCooking recipes and ingredients.' });
    await store.updateBlock(canvasId, original.id, { group: 'custom:cuisine', tags: ['manual recipe'] });
    const files = new JevWorkspaceFiles(directory); const state = await files.read(workspaceId);
    state.vocabulary = [{ id: 'cuisine', kind: 'group', name: 'Cuisine', groupKey: 'custom:cuisine', definition: 'Cooking recipes and ingredients',
      aliases: [], state: 'active', version: 1, members: [{ canvasId, blockId: original.id }] }];
    await files.write(workspaceId, state);
    const topics = [
      ['Architecture overview', '# Engineering\n## Backend\nPurpose: Engineering / Backend. Define service contracts.'],
      ['REST conventions', '# REST conventions\nPurpose: Engineering / Backend. Define service endpoints.'],
      ['Persistence model', '# Persistence model\nPurpose: Engineering / Backend. Define persistence schemas.'],
      ['Browser architecture', '# Engineering\n## Frontend\nPurpose: Engineering / Frontend. Define browser interaction.'],
      ['React components', '# React components\nPurpose: Engineering / Frontend. Compose browser components.'],
      ['Navigation behavior', '# Navigation behavior\nPurpose: Engineering / Frontend. Define browser navigation.'],
    ];
    const members = [];
    for (const [title, content] of topics) members.push(await store.createBlock(canvasId, { title, content, tags: ['manual label'] }));
    transform = (id, answer, body) => {
      const question = body.questions[id]; const source = (body.state.source ?? body.state.document) as { passages: Array<{ id: string; text: string }> };
      if (id === 'group' && question.type === 'choice') {
        if (!body.state.proposedGroups) return choiceAnswer(question, 'g0');
        const key = source.passages.some(passage => passage.text.includes('Engineering / Backend')) ? 'custom:engineering/backend' : 'custom:engineering/frontend';
        return choiceAnswer(question, Object.keys(question.criteria).find(candidate => question.criteria[candidate].includes(`(${key})`)) ?? 'none');
      }
      if (/^purpose(?:_\d+)?$/.test(id) && (body.state.selectedGroup as { key: string }).key === 'custom:cuisine') return { type: 'noul', noul: 0.01 };
      if (id === 'evidence' && question.type === 'choice') return choiceAnswer(question, source.passages.find(passage => passage.text.startsWith('Purpose:'))?.id ?? 'p0');
      return answer;
    };
    const owner = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true } as const;
    const runtime = new JevRuntime(store, { startTimer: false, evaluate: (context, request) => {
      context.apiKey = 'native-topic-key'; return evaluateJevAction(context, request);
    }, fetcher: (_url, options) => fetch(origin, options) });
    try {
      await runtime.configure(workspaceId, { externalProcessing: true, modes: { file: 'auto' } as JevSettings['modes'] }, owner);
      const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [original.id, ...members.map(member => member.id)] }, owner);
      await runtime.idle();
      const result = await runtime.read(workspaceId, owner);
      const finished = result.jobs.find(candidate => candidate.id === job.id);
      expect(finished?.state, JSON.stringify(finished)).toBe('completed');
      const proposals = result.proposals.filter(proposal => proposal.jobId === job.id);
      expect(proposals).toHaveLength(9); expect(proposals.every(proposal => proposal.state === 'applied')).toBe(true);
      expect(proposals.slice(0, 3).every(proposal => proposal.mutation.kind === 'vocabulary')).toBe(true);
      const saved = await new CanvasStore(directory).getCanvas(canvasId, true);
      for (const [index, member] of members.entries()) expect(saved.blocks.find(block => block.id === member.id))
        .toMatchObject({ content: member.content, tags: ['manual label'], group: index < 3 ? 'custom:engineering/backend' : 'custom:engineering/frontend' });
      expect(saved.blocks.find(block => block.id === original.id)).toMatchObject({ group: 'custom:cuisine', tags: ['manual recipe'], content: original.content });
      const terms = result.vocabulary.filter(term => term.groupKey?.startsWith('custom:engineering'));
      expect(terms.map(term => term.groupKey)).toEqual(['custom:engineering', 'custom:engineering/backend', 'custom:engineering/frontend']);
      expect(terms.filter(term => term.parentId).every(term => term.parentId === terms[0].id)).toBe(true);
      expect(proposals.filter(proposal => proposal.mutation.kind === 'document').every(proposal => proposal.sources.length === 1
        && proposal.evidence[0].quote.startsWith('Purpose:') && proposal.decisionConfidences?.length === 4)).toBe(true);
      expect(result.receipts.filter(receipt => receipt.proposalId && proposals.some(proposal => proposal.id === receipt.proposalId))
        .every(receipt => receipt.automatic)).toBe(true);
    } finally { runtime.close(); await runtime.idle(); await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  it('nominates explicit and evidenced subgroup definitions and preserves paths during rename', async () => {
    const input = context();
    const parent = { id: 'atlas_group', kind: 'group' as const, name: 'Atlas', groupKey: 'custom:atlas',
      definition: 'Atlas rollout work', aliases: [], state: 'active' as const, version: 1, members: [] };
    input.vocabulary.push(parent);
    const explicit = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'define', kind: 'group', name: 'Rollout', parentId: parent.id }));
    expect(explicit.proposals[0].mutation).toMatchObject({ term: { groupKey: 'custom:atlas/rollout', parentId: parent.id } });
    const inferred = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'define', kind: 'group', name: 'Pilot' }));
    expect(inferred.proposals[0].mutation).toMatchObject({ term: { groupKey: 'custom:atlas/pilot', parentId: parent.id } });
    input.vocabulary.push({ ...parent, id: 'pilot_group', name: 'Pilot', parentId: parent.id, groupKey: 'custom:atlas/pilot',
      members: [{ canvasId: 'canvas', blockId: 'primary' }] });
    input.documents[0].block.group = 'custom:atlas/pilot';
    const rename = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'rename', termId: parent.id, name: 'Project Atlas' }));
    expect(rename.proposals.some(proposal => proposal.mutation.kind === 'vocabulary' && proposal.mutation.term.groupKey === 'custom:project_atlas/pilot')).toBe(true);
    expect(rename.proposals.some(proposal => proposal.mutation.kind === 'document' && proposal.mutation.patch.group === 'custom:project_atlas/pilot')).toBe(true);
  });

  it('aggregates same-source edges and preserves real cross-canvas relation evidence', async () => {
    const input = context();
    input.documents[0].block.links = ['manual'];
    const result = await evaluateJevAction(input, request('link', { relation: 'implements' }));
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].mutation).toMatchObject({ patch: {
      links: ['manual', 'secondary'], linkTypes: { secondary: 'implements' },
      crossLinks: [{ canvasId: 'other', blockId: 'cross', relation: 'implements' }],
    } });
    expect(result.proposals[0].sources).toHaveLength(3);
    expect(result.proposals[0].confidence).toBeUndefined();
  });

  it('removes unsupported edges only with exact item ownership and preserves manual/pinned links', async () => {
    const input = context();
    input.documents[0].block.crossLinks = [{ canvasId: 'other', blockId: 'cross', relation: 'implements' }];
    input.documents[0].block.jevOwnership = { managed: ['link:canvas:secondary', 'link:other:cross'],
      pins: ['link:other:cross'], removedLabels: [], removedLinks: [] };
    transform = (id, answer) => id === 'supported' ? { type: 'noul', noul: 0.01 } : answer;
    const pinned = await recheckLinks(input, request('recheck_links'));
    expect(pinned.result.edges).toMatchObject([{ status: 'unsupported' }, { status: 'unsupported' }]);
    expect(pinned.proposals.find(proposal => proposal.mutation.kind === 'document')?.mutation)
      .toMatchObject({ patch: { links: [], linkTypes: {} } });
    expect((requests.at(-1)?.state.questionSets as Array<{ hypothesis: string }>).map(pair => pair.hypothesis))
      .toContain('source implements the explicit requirements or plan in target');
    input.documents[0].block.jevOwnership.pins = [];
    const owned = await recheckLinks(input, request('recheck_links'));
    expect(owned.proposals.find(proposal => proposal.mutation.kind === 'document')?.mutation)
      .toMatchObject({ patch: { links: [], crossLinks: [] } });
    input.documents[0].block.jevOwnership.managed = [];
    const manual = await recheckLinks(input, request('recheck_links'));
    expect(manual.proposals.every(proposal => proposal.mutation.kind === 'derived')).toBe(true);
    expect(input.documents[0].block.links).toEqual(['secondary']);
  });

  it('keeps local recall useful when provider fails or processing is disabled', async () => {
    responseStatus = 503;
    const input = context();
    const failed = await automaticRecall(input, request('recall'));
    expect(failed.result).toMatchObject({ evidenceFound: false, evidenceStatus: 'local_unverified', reranking: 'unavailable_local_fallback' });
    input.settings.externalProcessing = false;
    const disabled = await automaticRecall(input, request('recall'));
    expect(disabled.result).toMatchObject({ evidenceFound: false, evidenceStatus: 'local_unverified', reranking: 'unavailable_local_fallback' });
    expect(JSON.stringify(disabled)).not.toContain('fixture-only-key');
  });

  it.each(['promote', 'rename', 'alias', 'retire', 'restore'])('previews a complete %s vocabulary operation', async operation => {
    const input = context();
    const result = await automaticVocabulary(input, request('vocab_lifecycle', { operation, termId: 'atlas',
      name: operation === 'rename' ? 'Atlas delivery' : 'atlas', aliases: ['Atlas product'], definition: 'Atlas product delivery' }));
    expect(result.proposals[0].mutation).toMatchObject({ kind: 'vocabulary', operation,
      term: { id: 'atlas', version: 2, definition: 'Atlas product delivery' } });
    if (operation === 'rename') expect(result.proposals[1].mutation).toMatchObject({ patch: { tags: ['Atlas delivery'] } });
    expect(input.vocabulary[0].version).toBe(1);
  });

  it('previews merge migration, retirement, and split membership without independent writes', async () => {
    const input = context();
    const merged = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'merge', termId: 'atlas', targetId: 'rollout' }));
    expect(merged.proposals[0].mutation).toMatchObject({ operation: 'merge', previousId: 'atlas',
      term: { id: 'rollout', aliases: ['atlas'], members: [{ canvasId: 'canvas', blockId: 'primary' },
        { canvasId: 'canvas', blockId: 'secondary' }, { canvasId: 'other', blockId: 'cross' }] } });
    expect(merged.proposals[1].mutation).toMatchObject({ operation: 'retire', term: { id: 'atlas', state: 'retired' } });
    expect(merged.proposals[2].mutation).toMatchObject({ patch: { tags: ['rollout'] } });
    const split = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'split', termId: 'atlas', splitNames: ['Pilot', 'Deployment'] }));
    expect(split.proposals.filter(proposal => proposal.mutation.kind === 'vocabulary')).toHaveLength(3);
    expect(split.result).toMatchObject({ unresolvedMembers: [], retirementDeferredUntilAllMembersResolved: false });
    expect(split.proposals.some(proposal => proposal.mutation.kind === 'document')).toBe(true);
  });

  it('preserves unresolved split membership and detects invalid lifecycle requests', async () => {
    transform = (id, answer, body) => id === 'child' ? choiceAnswer(body.questions[id], 'none') : answer;
    const result = await automaticVocabulary(context(), request('vocab_lifecycle', { operation: 'split', termId: 'atlas', splitNames: ['Pilot', 'Deployment'] }));
    expect(result.result).toMatchObject({ unresolvedMembers: ['primary', 'secondary', 'cross'], retirementDeferredUntilAllMembersResolved: true });
    expect(result.proposals.some(proposal => proposal.mutation.kind === 'vocabulary' && proposal.mutation.operation === 'retire')).toBe(false);
    const invalid: NonNullable<JevActionRequest['options']>[] = [
      { operation: 'rename', termId: 'atlas' }, { operation: 'rename', termId: 'atlas', name: 'rollout' },
      { operation: 'merge', termId: 'atlas', targetId: 'atlas' }, { operation: 'promote', termId: 'missing' },
      { operation: 'split', termId: 'atlas', splitNames: ['one'] }, { operation: 'explode', termId: 'atlas' },
      { operation: 'nominate', name: 'New entity', kind: 'invalid' },
    ];
    for (const options of invalid) await expect(async () => {
      const legacy = request('vocab_lifecycle', options); validateActionOptions(legacy);
      return automaticVocabulary(context(), legacy);
    }).rejects.toMatchObject({ status: expect.any(Number) });
  });

  it('never sends excluded sources or other-workspace candidates to a provider', async () => {
    const input = context();
    input.documents[0].block.processingExcluded = true;
    await expect(evaluateJevAction(input, request('profile'))).rejects.toMatchObject({ status: 404 });
    expect(requests).toHaveLength(0);
    const local = await automaticRecall(input, request('recall'));
    expect(JSON.stringify(local.result.passages)).toContain('excluded_from_external_processing');
    const privateDocument = document('canvas', block('restricted', { title: 'PRIVATE_TITLE', content: 'PRIVATE_CONTENT' }));
    privateDocument.snapshot.workspaceId = 'another-workspace';
    input.documents[0].block.processingExcluded = false;
    input.documents.push(privateDocument);
    await evaluateJevAction(input, request('link'));
    expect(JSON.stringify(requests)).not.toContain('PRIVATE_CONTENT');
    expect(JSON.stringify(requests)).not.toContain('PRIVATE_TITLE');
    await expect(evaluateJevAction(input, { ...request('profile'), blockIds: ['restricted'] })).rejects.toMatchObject({ status: 404 });
    await expect(evaluateJevAction(input, { ...request('profile'), canvasId: 'restricted' })).rejects.toMatchObject({ status: 404 });
  });

  it('supports reviewer selection and refuses unknown task/person identities', async () => {
    const result = await assignOwner(context(), request('assign_owner', { subaction: 'assign_reviewer', taskId: 'pilot' }));
    expect(result.proposals[0].mutation).toMatchObject({ patch: { reviewer: 'maya' } });
    const input = context();
    input.settings.people = [];
    expect((await assignOwner(input, request('assign_owner'))).result.status).toBe('no_known_people');
    await expect(attachDocToTask(context(), request('attach_doc_to_task', { taskId: 'missing' }))).rejects.toMatchObject({ status: 404 });
  });

  it('abstains when source quotes or decisions are unsupported and reports missing candidates', async () => {
    transform = (id, answer, body) => answer.type === 'choice' && 'none' in (body.questions[id] as { criteria: Record<string, string> }).criteria
      ? choiceAnswer(body.questions[id], 'none') : answer.type === 'noul' ? { type: 'noul', noul: 0.05 } : answer;
    for (const action of ['file', 'label', 'suggest_home_canvas',
      'link', 'flag_duplicate'] as const) {
      const result = await evaluateJevAction(context(), request(action));
      expect(result.proposals.every(proposal => proposal.mutation.kind === 'derived' || action === 'label')).toBe(true);
    }
    const input = context();
    input.vocabulary = [];
    input.documents.forEach(document => { document.block.group = undefined; document.block.tags = []; });
    input.canvases[0].groups = [];
    expect((await evaluateJevAction(input, request('file'))).result.status).toBe('insufficient_group_evidence');
    expect((await evaluateJevAction(input, request('label'))).result.status).toBe('missing_label_vocabulary');
  });

  it('uses the native provider default and environment key without exposing it in decision state', async () => {
    const input = context();
    input.decider = undefined; input.apiKey = undefined; input.now = undefined;
    const oldFetch = globalThis.fetch;
    const previousKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'fixture-only-key';
    globalThis.fetch = (_url, init) => oldFetch(`${origin}/v1/systemone`, init);
    try {
      const result = await evaluateJevAction(input, request('profile'));
      expect(JSON.stringify(result.result.documents)).toContain('analyzedAt');
      expect(requests[0].state.decisionProgram).toMatchObject({ questionVersion: JEV_QUESTION_VERSION, sourceTrust: 'untrusted_evidence' });
      expect(JSON.stringify(requests)).not.toContain('fixture-only-key');
    } finally {
      globalThis.fetch = oldFetch;
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
    }
  });

  it('keeps quality findings unknown when their supporting passage is missing', async () => {
    transform = (id, answer, body) => id.toLowerCase().includes('evidence') ? choiceAnswer(body.questions[id], 'none') : answer;
    const quality = await scoreQuality(context(), request('score_quality'));
    expect(quality.result.documents).toMatchObject({ primary: { rubric: { specificity: { status: 'insufficient_evidence' } } } });
  });
});

function choiceAnswer(question: JevQuestion, selected: string): JevAnswer {
  if (question.type !== 'choice') throw new Error('Expected a Choice question');
  return { type: 'choice', choice: selected, confidence: 0.97,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? 1 : 0])) };
}

function groupAnswer(question: JevQuestion, groupKey: string, allowAlternative = false): JevAnswer {
  if (question.type !== 'choice') throw new Error('Expected a group Choice question');
  const criteria = question.criteria;
  const fallback = allowAlternative ? Object.keys(criteria)[0] : 'none';
  return choiceAnswer(question, Object.keys(criteria).find(key => criteria[key].includes(`(${groupKey})`)) ?? fallback);
}
