import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { decideWithJev, type JevQuestion } from '../../jev.js';
import { evaluateJevAction, type JevEvaluationContext } from '../actions.js';
import { emptyJevWorkspace } from '../workspace.js';

let server: Server;
let origin: string;
let requests: Array<{ state: Record<string, unknown>; questions: Record<string, JevQuestion> }>;
let unsupportedKey: string | undefined;
beforeEach(async () => {
  requests = []; unsupportedKey = undefined;
  server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw); requests.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, JevQuestion>).map(([id, question]) => {
      const indexed = /^(\d+)__(.+)$/.exec(id);
      const state = indexed ? body.state.questionSets[Number(indexed[1])] : body.state;
      const name = indexed ? indexed[2] : id;
      if (question.type === 'noul') return [id, { type: 'noul', noul: name.startsWith('purpose_')
        && state.selectedGroup.key === unsupportedKey ? .01 : .98 }];
      if (question.type !== 'choice') throw new Error('Unexpected filing score');
      const keys = Object.keys(question.criteria); const choice = keys[0];
      return [id, { type: 'choice', choice, confidence: .98,
        probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
    }));
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ answers }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native filing provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function context(): JevEvaluationContext {
  const source = { canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source',
    incarnation: 'original', sourceGeneration: 1, metadataRevision: 0, contentHash: 'exact-source' },
    block: { id: 'source', title: 'Architecture', file: 'source.md', kind: 'markdown' as const, x: 123, y: 456,
      width: 400, height: 300, links: [], content: '# Architecture\nPlatform infrastructure and deployment requirements.' } };
  return { workspaceId: 'workspace', documents: [source], vocabulary: [], tasks: [],
    canvases: [{ id: 'canvas', name: 'Platform', groups: [{ id: 'custom:platform', name: 'Platform', definition: 'Platform infrastructure' }] }],
    settings: emptyJevWorkspace().settings, apiKey: 'native-filing-flow',
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options) };
}
it('checks an existing group and every exact local support candidate in one SDK wave', async () => {
  const input = context(); const source = input.documents[0]; const before = structuredClone(source);
  const result = await evaluateJevAction(input, { action: 'file', canvasId: 'canvas', blockIds: ['source'] });
  expect(requests).toHaveLength(1);
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', blockId: 'source', patch: { group: 'custom:platform' } });
  expect(result.proposals[0].decisionConfidences).toEqual([.98, .98]);
  expect(result.proposals[0].sources).toEqual([source.snapshot]);
  for (const passage of result.proposals[0].evidence) expect(source.block.content.slice(passage.start, passage.end)).toBe(passage.quote);
  expect(source).toEqual(before);
});
it('retries only selection after a rejected existing group and reuses the other candidate exact assessments', async () => {
  const input = context(); unsupportedKey = 'custom:platform';
  input.canvases[0].groups!.push({ id: 'custom:deployment', name: 'Deployment', definition: 'Deployment requirements' });
  const result = await evaluateJevAction(input, { action: 'file', canvasId: 'canvas', blockIds: ['source'] });
  expect(requests).toHaveLength(2); expect(Object.keys(requests[1].questions)).toEqual(['group']);
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { group: 'custom:deployment' } });
  expect(result.proposals[0].decisionConfidences).toEqual([.98, .98]);
  expect(result.proposals[0].sources).toEqual([input.documents[0].snapshot]);
});
