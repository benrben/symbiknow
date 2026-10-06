import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { assertValidJevRequest, decideWithJev, estimateJevTokens, noul } from './jev.js';

function questionsWithTotal(tokens: number) {
  const questions = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`q${i}`, noul('x'.repeat(1000))]));
  const difference = tokens * 3 - Buffer.byteLength(JSON.stringify(questions));
  questions.q0.instructions += 'y'.repeat(difference);
  return questions;
}

it('rejects the aggregate limit before native network admission even when every individual question fits', async () => {
  let calls = 0;
  const server = createServer((_request, response) => { calls += 1; response.end('{}'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native address');
  const questions = questionsWithTotal(64000);
  expect(estimateJevTokens({}) + estimateJevTokens(questions)).toBe(64001);
  expect(Math.max(...Object.values(questions).map(estimateJevTokens))).toBeLessThan(32000);
  try {
    await expect(decideWithJev('native-budget', {}, questions, (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init)))
      .rejects.toMatchObject({ status: 413 });
    expect(calls).toBe(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('accepts the exact aggregate boundary and rejects one additional token without mutating the request', () => {
  const questions = questionsWithTotal(63999); const original = structuredClone(questions);
  expect(estimateJevTokens({}) + estimateJevTokens(questions)).toBe(64000);
  expect(() => assertValidJevRequest({}, questions)).not.toThrow();
  expect(questions).toEqual(original);
  questions.q0.instructions += 'xxx';
  expect(() => assertValidJevRequest({}, questions)).toThrow(/too large/);
});
