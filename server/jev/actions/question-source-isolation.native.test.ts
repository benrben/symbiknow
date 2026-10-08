import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { decideWithJev, noul, type JevQuestion } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import { judgeQuestionSets } from './question-batch.js';

it.each([false, true])('keeps unrelated source prose out of native judgments and remaps interleaved answers (shared=%s)', async shared => {
  const bodies: Array<{ state: unknown; questions: Record<string, JevQuestion> }> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    // A provider that reads all supplied evidence reproduces the live cross-file contamination.
    const value = JSON.stringify(body.state).includes('SSO assertion validation') ? .98 : .01;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: value }])) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Provider did not listen');
  const origin = `http://127.0.0.1:${address.port}`;
  const pricing = { id: 'pricing', title: 'Pricing decision', passages: [{ id: 'p0', text: '49 dollars per seat, approved.' }], coverage: 1 };
  const security = { id: 'security', title: 'Security review', passages: [{ id: 'p0', text: 'SSO assertion validation remains blocked.' }], coverage: 1 };
  const sets = [pricing, security, pricing].map((document, index) => ({ state: { document, index }, questions: { sso: noul('Is SSO the main topic of this document?') } }));
  try {
    const answers = await judgeQuestionSets({ workspaceId: 'test', documents: [], canvases: [], tasks: [], vocabulary: [],
      settings: emptyJevWorkspace().settings, apiKey: 'native-fixture', shareQuestionSources: shared,
      decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options) }, sets);
    expect(answers).toEqual([.01, .98, .01].map(noul => ({ sso: { type: 'noul', noul } })));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      const wire = JSON.stringify(body.state);
      expect(wire.includes('49 dollars') && wire.includes('SSO assertion')).toBe(false);
    }
    expect(Object.keys(bodies[0].questions)).toEqual(['0__sso', '1__sso']);
    expect(Object.keys(bodies[1].questions)).toEqual(['sso']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
