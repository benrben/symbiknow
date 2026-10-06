import { createServer } from 'node:http';

export const state = { text: 'A caller supplies the context and defines its own decision.' };
export const validAnswers = {
  route: { type: 'choice', choice: 'defer', probabilities: { proceed: 0.2, defer: 0.8 }, confidence: 0.8 },
  priority: { type: 'score', score: 2, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, confidence: 0.7 },
  eligible: { type: 'noul', noul: 0.25 },
};

export function questions(sdk) {
  return {
    route: sdk.choice('Choose from the supplied options.', { proceed: 'Enough context', defer: 'Needs more context' }),
    priority: sdk.score('Rate the supplied context.', ['Low', 'Medium', 'High']),
    eligible: sdk.noul('Does the supplied context meet the caller criteria?', { true: 'Yes', false: 'No' }),
  };
}

export async function openProvider() {
  const requests = [];
  let reply = () => ({ status: 200, body: { answers: validAnswers } });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ body, authorization: request.headers.authorization });
    const result = reply(body, requests.length);
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    fetcher: (_url, options) => fetch(base, options),
    setReply: next => { reply = next; },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
