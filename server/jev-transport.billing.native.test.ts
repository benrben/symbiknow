import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { decideWithJev, JEV_MODEL, noul, type JevQuestion } from './jev.js';
import { isJevBillingFailure } from './jev-provider-error.js';

type Reply = { status: number; body: string; broken?: boolean };
type DecisionRequest = { model: string; state: unknown; questions: Record<string, JevQuestion> };
type Fixture = { server: Server; requests: DecisionRequest[]; failures: unknown[]; fetcher: typeof fetch };
const fixtures: Fixture[] = [];
const state = { source: 'Checked native billing transport evidence.' };
const questions = { supported: noul('Does the supplied source support this finding?') };

async function fixture(reply: Reply): Promise<Fixture> {
  const requests: DecisionRequest[] = []; const failures: unknown[] = [];
  let broken: ServerResponse | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''; for await (const chunk of request) body += String(chunk);
      expect(request.method).toBe('POST'); expect(request.url).toBe('/v1/systemone');
      expect(request.headers.authorization).toBe('Bearer native-billing-fixture');
      requests.push(JSON.parse(body) as DecisionRequest);
      if (reply.broken) {
        broken = response;
        response.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': String(reply.body.length + 1000) });
        response.flushHeaders(); response.write(reply.body); return;
      }
      response.writeHead(reply.status, { 'content-type': 'application/json' }); response.end(reply.body);
    })().catch(error => { failures.push(error); response.destroy(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native billing provider did not bind');
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe('https://api.typesafe.ai/v1/systemone');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/systemone`, init);
    // Interrupt an actual response stream only after native fetch has delivered its checked HTTP status.
    broken?.destroy(); return response;
  };
  const native = { server, requests, failures, fetcher }; fixtures.push(native); return native;
}

afterEach(async () => {
  for (const native of fixtures.splice(0)) {
    native.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => native.server.close(error => error ? reject(error) : resolve()));
    expect(native.failures).toEqual([]);
  }
});

it.each([
  { label: 'structured JSON billing', body: JSON.stringify({ detail: { error_type: 'insufficient_balance' } }), suffix: ': insufficient balance' },
  { label: 'bounded JSON diagnostic', body: JSON.stringify({ detail: 'b'.repeat(251) }), suffix: `: ${'b'.repeat(250)}` },
  { label: 'non-JSON billing', body: 'Payment required', suffix: '' },
  { label: 'oversized billing body', body: 'x'.repeat(262_145), suffix: '' },
  { label: 'empty billing body', body: '', suffix: '' },
  { label: 'native response read failure', body: '{"detail":"Unfinished native billing', suffix: '', broken: true },
])('retains trusted402 classification and the existing public502 contract for $label without SDK retries', async ({ body, suffix, ...reply }) => {
  const native = await fixture({ status: 402, body, ...reply });
  const error = await decideWithJev('native-billing-fixture', state, questions, native.fetcher, { baseDelayMs: 0 }).catch(error => error as unknown);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 502, message: `Jev request failed (402)${suffix}` });
  expect(isJevBillingFailure(error as ApiError)).toBe(true);
  expect(native.requests).toEqual([{ model: JEV_MODEL, state, questions }]);
  expect(Object.keys(error as ApiError)).not.toContain('upstreamStatus');
});

it('does not classify a non402 native response by an untrusted billing diagnostic', async () => {
  const native = await fixture({ status: 400, body: JSON.stringify({ detail: 'Jev request failed (402): insufficient balance' }) });
  const error = await decideWithJev('native-billing-fixture', state, questions, native.fetcher, { baseDelayMs: 0 }).catch(error => error as unknown);
  expect(error).toMatchObject({ status: 502, message: 'Jev request failed (400): Jev request failed (402): insufficient balance' });
  expect(isJevBillingFailure(error as ApiError)).toBe(false);
  expect(native.requests).toEqual([{ model: JEV_MODEL, state, questions }]);
});
