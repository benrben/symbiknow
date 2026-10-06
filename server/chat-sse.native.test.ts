import { afterEach, expect, it } from 'vitest';
import { createServer, request as nativeRequest, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatStreamSession } from './chat-agent.js';
import { sendChatStream } from './chat-sse.js';
import { ApiError } from './errors.js';
import { CanvasStore } from './storage.js';
import { answer, begin, fixture, nextRequest } from './chat-session.test.fixture.js';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function endpoint(session: ChatStreamSession, signal?: AbortSignal) {
  let finished!: (result: { headersSent: boolean; error: unknown }) => void;
  const done = new Promise<{ headersSent: boolean; error: unknown }>(resolve => { finished = resolve; });
  const server = createServer(async (_request, response) => {
    try {
      await sendChatStream(response, session, signal);
      finished({ headersSent: response.headersSent, error: undefined });
    } catch (error) {
      finished({ headersSent: response.headersSent, error });
      response.writeHead(error instanceof ApiError ? error.status : 500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof ApiError ? error.message : 'Native stream preparation failed' }));
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native SSE address');
  return { base: `http://127.0.0.1:${address.port}`, done };
}

it('propagates a real installed-provider failure before the first token without SSE headers and recovers through the public tokens-only contract', async () => {
  const setup = await fixture();
  setup.model.handle = (_body, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Rejected local-model-secret', type: 'request_error' } }));
  };
  const prepared = await setup.sessionContext();
  const rejected = await endpoint({ model: prepared.session.model, tokens: prepared.session.tokens });
  const response = await fetch(rejected.base);
  expect(response.status).toBe(502);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toEqual({ error: 'Local provider request failed (401). The API key was rejected. Check it in Settings.' });
  expect(await rejected.done).toMatchObject({ headersSent: false, error: { status: 502 } });
  expect(prepared.cleanup.closed).toBe(1);
  setup.model.handle = (_body, result) => answer(result, ['Recovered native tokens.']);
  const recovered = await setup.sessionContext();
  const retry = await endpoint({ model: recovered.session.model, tokens: recovered.session.tokens });
  const retried = await fetch(retry.base);
  expect(retried.status).toBe(200);
  expect(retried.headers.get('content-type')).toContain('text/event-stream');
  const stream = await retried.text();
  expect(stream).toContain('Recovered native tokens.');
  expect(stream).toContain('"finish_reason":"stop"');
  expect(stream).toContain('data: [DONE]');
  expect(stream).not.toContain('event: error');
  expect(await retry.done).toEqual({ headersSent: true, error: undefined });
  expect(recovered.cleanup.closed).toBe(1);
  expect(setup.model.requests).toHaveLength(2);
  expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
});

it('redacts a genuine filesystem cleanup failure after installed-agent text, finishes the stream and allows a fresh native retry', async () => {
  const setup = await fixture();
  const prepared: Awaited<ReturnType<typeof setup.sessionContext>> = await setup.sessionContext({ close: async () => {
    await prepared.cleanup.file.close();
    await readFile(path.join(setup.root, 'missing-native-cleanup-source'), 'utf8');
  } });
  const api = await endpoint(prepared.session);
  const response = await fetch(api.base);
  expect(response.status).toBe(200);
  const stream = await response.text();
  expect(stream).toContain('The release ');
  expect(stream).toContain('requires QA approval.');
  expect(stream).toContain('event: error\ndata: {"message":"Chat stream stopped. Check the model settings."}');
  expect(stream).toContain('"finish_reason":"stop"');
  expect(stream).toContain('data: [DONE]');
  expect(stream).not.toContain(setup.root);
  expect(stream).not.toContain('ENOENT');
  expect(stream).not.toContain('local-model-secret');
  expect(prepared.cleanup.file.fd).toBe(-1);
  expect(await api.done).toEqual({ headersSent: true, error: undefined });
  const recovered = await setup.sessionContext();
  const retry = await endpoint(recovered.session);
  const recoveredStream = await fetch(retry.base).then(result => result.text());
  expect(recoveredStream).toContain('requires QA approval.');
  expect(recoveredStream).toContain('data: [DONE]');
  expect(recoveredStream).not.toContain('event: error');
  expect(await retry.done).toEqual({ headersSent: true, error: undefined });
  expect(setup.model.requests).toHaveLength(2);
  expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
});

it('cancels a native tokens-only request before its first token without headers, errors or document writes', async () => {
  const setup = await fixture();
  setup.model.handle = (_body, response) => begin(response);
  const prepared = await setup.sessionContext();
  const api = await endpoint({ model: prepared.session.model, tokens: prepared.session.tokens });
  const entered = nextRequest(setup.model);
  const outgoing = nativeRequest(api.base);
  const failed = new Promise<string | undefined>(resolve => outgoing.once('error', error => resolve((error as NodeJS.ErrnoException).code)));
  outgoing.end();
  await entered;
  outgoing.destroy();
  expect(await failed).toBe('ECONNRESET');
  expect(await api.done).toEqual({ headersSent: false, error: undefined });
  expect(prepared.cleanup.closed).toBe(1);
  await expect.poll(() => setup.model.closed).toBe(1);
  expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
});

it('suppresses a native cleanup exception after a real HTTP disconnect and recovers without a terminal error or completion event', async () => {
  const setup = await fixture();
  setup.model.handle = (_body, response) => begin(response);
  const prepared: Awaited<ReturnType<typeof setup.sessionContext>> = await setup.sessionContext({ close: async () => {
    await prepared.cleanup.file.close();
    await readFile(path.join(setup.root, 'missing-cancelled-cleanup-source'), 'utf8');
  } });
  const api = await endpoint(prepared.session, new AbortController().signal);
  const entered = nextRequest(setup.model);
  const stopped = new AbortController();
  const response = await fetch(api.base, { signal: stopped.signal });
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('event: agent_step');
  await entered;
  stopped.abort();
  await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
  expect(await api.done).toEqual({ headersSent: true, error: undefined });
  expect(prepared.cleanup.file.fd).toBe(-1);
  await expect.poll(() => setup.model.closed).toBe(1);
  setup.model.handle = (_body, result) => answer(result, ['Recovered after native disconnect.']);
  const recovered = await setup.sessionContext();
  const retry = await endpoint(recovered.session);
  const stream = await fetch(retry.base).then(result => result.text());
  expect(stream).toContain('Recovered after native disconnect.');
  expect(stream).toContain('data: [DONE]');
  expect(stream).not.toContain('event: error');
  expect(await retry.done).toEqual({ headersSent: true, error: undefined });
  expect(setup.model.requests).toHaveLength(2);
  expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
});
