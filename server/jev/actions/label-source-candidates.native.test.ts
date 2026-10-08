import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { decideWithJev, type JevQuestion } from '../../jev.js';
import { evaluateJevAction, type JevEvaluationContext } from '../actions.js';
import { calibrated, decisionBoundaries } from './calibration.js';
import { emptyJevWorkspace } from '../workspace.js';

let server: Server;
let origin: string;
let requests: Array<{ state: { labelCandidates: Array<{ name: string; definition: string }> }; questions: Record<string, JevQuestion> }>;
let support: number;
let evidence: boolean;
let sourceBackedOnly: boolean;
let requireNamedTopics: boolean;
beforeEach(async () => {
  requests = []; support = .9; evidence = true; sourceBackedOnly = false; requireNamedTopics = false;
  server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw); requests.push(body);
    const namesMissing = Object.entries(body.questions as Record<string, JevQuestion>).some(([id, question]) => {
      const candidate = body.state.labelCandidates[Number(id.split('_')[1])];
      return !question.instructions.includes(JSON.stringify(candidate.name))
        || !question.instructions.includes(JSON.stringify(candidate.definition));
    });
    if (requireNamedTopics && namesMissing) {
      response.statusCode = 422;
      response.end('Each decision must explicitly identify its supplied topic and scope');
      return;
    }
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, JevQuestion>).map(([id, question]) => {
      const name = body.state.labelCandidates[Number(id.split('_')[1])].name;
      const passage = body.state.document.passages.find((item: { text: string }) => item.text.includes(name));
      if (question.type === 'noul') return [id, { type: 'noul', noul: sourceBackedOnly && !passage ? .01 : support }];
      if (question.type !== 'choice') throw new Error('Unexpected label question');
      const keys = Object.keys(question.criteria);
      const choice = evidence ? (sourceBackedOnly ? passage?.id ?? 'none' : keys[0]) : 'none';
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
  expect(result.proposals[0].decisionConfidences).toEqual([calibrated(.9, decisionBoundaries.topicMembership), calibrated(.9, decisionBoundaries.topicMembership)]);
  for (const passage of result.proposals[0].evidence) expect(input.documents[0].block.content.slice(passage.start, passage.end)).toBe(passage.quote);
  expect(input.vocabulary).toEqual([]); expect(input.documents).toEqual(before);
});
it('names each topic and definition in native provider questions and explains substantive category membership', async () => {
  requireNamedTopics = true;
  const input = context();
  input.vocabulary = [{ id: 'security', kind: 'label', name: 'Security', definition: 'Protecting account access and authentication boundaries.',
    aliases: [], state: 'active', version: 1, members: [{ canvasId: 'canvas', blockId: 'source' }] }];
  const result = await evaluateJevAction(input, request);
  expect(result.proposals).toHaveLength(1);
  const submitted = requests[0];
  submitted.state.labelCandidates.forEach((candidate, index) => {
    expect(submitted.questions[`label_${index}`].instructions).toContain(JSON.stringify(candidate.name));
    expect(submitted.questions[`label_${index}`].instructions).toContain(JSON.stringify(candidate.definition));
    expect(submitted.questions[`label_${index}`].instructions).toMatch(/subject category/);
    expect(submitted.questions[`label_${index}`].instructions).toMatch(/substantive passages/);
    expect(submitted.questions[`evidence_${index}`].instructions).toContain(JSON.stringify(candidate.name));
    expect(submitted.questions[`evidence_${index}`].instructions).toContain(JSON.stringify(candidate.definition));
  });
});
it.each(['threshold', 'evidence'] as const)('requires the unchanged %s guard for source-derived labels', async failure => {
  const input = context();
  if (failure === 'threshold') input.settings.confidenceThresholds = { label: .98 }; else evidence = false;
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
it('prioritizes existing label candidates while retaining fresh topics and bounding heading candidates', async () => {
  const input = context();
  input.documents[0].block.tags = ['Established'];
  await evaluateJevAction(input, request);
  expect(requests[0].state.labelCandidates.map(candidate => candidate.name)).toEqual(['Established', 'New hire access', 'Employee Onboarding']);
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

it('keeps the current source topic inside the bounded candidate set when many unrelated labels are known', async () => {
  sourceBackedOnly = true;
  const input = context();
  input.documents[0].block.content = '# SSO security review\n\nRetest SAML assertion audience validation before administrator SSO approval.';
  input.documents[0].block.title = 'SSO security review';
  input.documents[1].block.tags = Array.from({ length: 40 }, (_, index) => `Unrelated operations ${index}`);
  const result = await evaluateJevAction(input, request);
  expect(requests[0].state.labelCandidates).toHaveLength(8);
  expect(requests[0].state.labelCandidates[0].name).toBe('SSO security review');
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { tags: ['SSO security review'] } });
});

it('retains fresh launch source topics after an earlier document has received an unrelated label', async () => {
  sourceBackedOnly = true;
  const input = context();
  const sources = [
    ['SSO security review', 'Confirm SAML issuer validation and reject unsigned assertions before the enterprise launch.'],
    ['Pen test', 'Test authorization boundaries and record the remediation for cross-tenant access findings.'],
    ['Access policy', 'Require multifactor authentication and least privilege for administrator access.'],
    ['Pricing decision', 'Approve the enterprise subscription price and the usage limits for the launch offer.'],
    ['Pricing copy', 'Publish the approved enterprise subscription price and usage limits on the pricing page.'],
    ['Launch blockers', 'Do not ship until the security review and pricing approval have cleared their launch blockers.'],
    ['Rollback runbook', 'Restore the previous deployment and verify service health if the launch fails.'],
    ['SSO security review copy', 'Confirm SAML issuer validation and reject unsigned assertions before the enterprise launch.'],
  ];
  const template = input.documents[0];
  input.documents = sources.map(([title, body], index) => ({ ...template,
    snapshot: { ...template.snapshot, blockId: `launch-${index}`, contentHash: `launch-source-${index}` },
    block: { ...template.block, id: `launch-${index}`, title, content: `# ${title}\n\n${body}` },
  }));
  input.documents[7].block.content = input.documents[0].block.content;
  input.documents[7].snapshot.contentHash = input.documents[0].snapshot.contentHash;
  input.documents.push({ ...template, snapshot: { ...template.snapshot, blockId: 'previous' },
    block: { ...template.block, id: 'previous', tags: ['Employee Onboarding'] } });
  for (const document of input.documents.slice(0, 8)) {
    const result = await evaluateJevAction(input, { ...request, blockIds: [document.block.id] });
    const candidates = requests.at(-1)!.state.labelCandidates.map(candidate => candidate.name);
    const expectedTopic = document.block.id === 'launch-7' ? 'SSO security review' : document.block.title;
    expect(candidates, document.block.title).toContain(expectedTopic);
    expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { tags: [expectedTopic] } });
    for (const passage of result.proposals[0].evidence) expect(document.block.content.slice(passage.start, passage.end)).toBe(passage.quote);
  }
});
