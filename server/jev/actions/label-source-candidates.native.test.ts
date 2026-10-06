import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { decideWithJev, type JevQuestion } from '../../jev.js';
import { evaluateJevAction, type JevEvaluationContext } from '../actions.js';
import { emptyJevWorkspace } from '../workspace.js';

let server: Server;
let origin: string;
let requests: Array<{ state: { labelCandidates: Array<{ name: string }> }; questions: Record<string, JevQuestion> }>;
let support: number;
let evidence: boolean;
beforeEach(async () => {
  requests = []; support = .9; evidence = true;
  server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw); requests.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, JevQuestion>).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: support }];
      if (question.type !== 'choice') throw new Error('Unexpected label question');
      const keys = Object.keys(question.criteria); const choice = evidence ? keys[0] : 'none';
      return [id, { type: 'choice', choice, confidence: .98,
        probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
    }));
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ answers }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local label provider unavailable');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function context(): JevEvaluationContext {
  const content = '# New hire access\n\nEmployee Onboarding · Account setup\n\nCreate an account and enable multifactor authentication before the first day.';
  const source = { canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source',
    incarnation: 'original', sourceGeneration: 1, metadataRevision: 0, contentHash: 'exact-source' },
    block: { id: 'source', title: 'New hire access', file: 'source.md', kind: 'markdown' as const, x: 123, y: 456,
      width: 400, height: 300, links: [], content } };
  const neighbor = { ...source, snapshot: { ...source.snapshot, blockId: 'neighbor' },
    block: { ...source.block, id: 'neighbor', title: 'First week', content: '# First week\n\nEmployee Onboarding · Team introduction\n\nMeet your manager.' } };
  return { workspaceId: 'workspace', documents: [source, neighbor], vocabulary: [], tasks: [],
    canvases: [{ id: 'canvas', name: 'New workspace' }], settings: emptyJevWorkspace().settings, apiKey: 'local-label-test',
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options) };
}
const request = { action: 'label' as const, canvasId: 'canvas', blockIds: ['source'] };
it('labels fresh sources from shared categories and local headings without vocabulary maintenance', async () => {
  const input = context(); const before = structuredClone(input.documents);
  const result = await evaluateJevAction(input, request);
  expect(requests).toHaveLength(1);
  expect(requests[0].state.labelCandidates.map(candidate => candidate.name)).toEqual(expect.arrayContaining(['Employee Onboarding', 'New hire access']));
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { tags: expect.arrayContaining(['Employee Onboarding', 'New hire access']) } });
  expect(result.proposals[0].decisionConfidences).toEqual([.9, .9]);
  for (const passage of result.proposals[0].evidence) expect(input.documents[0].block.content.slice(passage.start, passage.end)).toBe(passage.quote);
  expect(input.vocabulary).toEqual([]); expect(input.documents).toEqual(before);
});
it.each(['threshold', 'evidence'] as const)('requires the unchanged %s guard for source-derived labels', async failure => {
  const input = context();
  if (failure === 'threshold') input.settings.confidenceThresholds = { label: .95 }; else evidence = false;
  const result = await evaluateJevAction(input, request);
  expect(requests).toHaveLength(1); expect(result.proposals).toEqual([]);
});
it('does not nominate manually removed labels or retired vocabulary aliases', async () => {
  const input = context();
  input.documents[0].block.jevOwnership = { pins: [], managed: ['tags'], removedLabels: ['Employee Onboarding'], removedLinks: [] };
  input.vocabulary = [{ id: 'retired', kind: 'label', name: 'Account access', aliases: ['New hire access'], definition: 'Old label', state: 'retired', version: 1, members: [] }];
  const result = await evaluateJevAction(input, request);
  expect(requests).toEqual([]); expect(result.proposals).toEqual([]);
});
it('keeps existing label candidates and bounds fresh heading candidates', async () => {
  const input = context();
  input.documents[0].block.tags = ['Established'];
  await evaluateJevAction(input, request);
  expect(requests[0].state.labelCandidates.map(candidate => candidate.name)).toEqual(['Established']);
  requests = []; input.documents[0].block.tags = [];
  input.documents[0].block.content = Array.from({ length: 30 }, (_, index) => `## Topic ${index}\n\nUseful explanation for topic ${index}.`).join('\n\n');
  await evaluateJevAction(input, request);
  expect(requests[0].state.labelCandidates).toHaveLength(8);
  expect(Object.keys(requests[0].questions)).toHaveLength(16);
});
it('records no candidate when a fresh source has no headings or shared category', async () => {
  const input = context(); input.documents[0].block.content = 'Unstructured prose with no source category.';
  const result = await evaluateJevAction(input, request);
  expect(result.result.status).toBe('missing_label_vocabulary'); expect(requests).toEqual([]);
});
