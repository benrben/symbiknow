import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentProgress, chatAgent, collectSnapshot, finalAnswer, type ChatStreamEvent } from './chat-agent.js';
import { CanvasStore } from './storage.js';
import { createApiServer } from './index.js';

type ProviderRequest = { model: string; stream: boolean; messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools: Array<{ function: { name: string } }> };
const servers: Server[] = [];
const roots: string[] = [];
const completionIds = new WeakMap<ServerResponse, string>();
let completions = 0;
async function provider(handle: (body: ProviderRequest, request: IncomingMessage, response: ServerResponse) => void) {
  const requests: ProviderRequest[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as ProviderRequest;
    requests.push(body);
    handle(body, request, response);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing provider port');
  return { requests, settings: { model: 'native-fixture', apiKey: 'private-local-key', baseURL: `http://127.0.0.1:${address.port}/v1`, headers: {} } };
}
function begin(response: ServerResponse) { completionIds.set(response, `completion-${++completions}`); response.writeHead(200, { 'content-type': 'text/event-stream' }); }
function chunk(response: ServerResponse, delta: unknown, finish: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: completionIds.get(response), object: 'chat.completion.chunk', created: 1, model: 'native-fixture',
    choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function finish(response: ServerResponse) { chunk(response, {}, 'stop'); response.end('data: [DONE]\n\n'); }
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('installed Deep Agents at a native provider boundary', () => {
  it('executes a real structured tool and streams its tool progress and final answer', async () => {
    const calls: string[] = [];
    const lookup = tool(async ({ id }) => { calls.push(id); return 'Verified source text'; },
      { name: 'lookup_document', description: 'Read a source document', schema: z.object({ id: z.string() }) });
    const { requests, settings } = await provider((body, request, response) => {
      expect(request.url).toBe('/v1/chat/completions');
      expect(request.headers.authorization).toBe('Bearer private-local-key');
      begin(response);
      if (!body.messages.some(message => message.role === 'tool')) {
        chunk(response, { role: 'assistant', content: 'Checking the source. ' });
        chunk(response, { tool_calls: [{ index: 0, id: 'lookup-1', type: 'function', function: { name: 'lookup_document', arguments: '{"id":"one"}' } }] }, 'tool_calls');
        response.end('data: [DONE]\n\n');
      } else { chunk(response, { role: 'assistant', content: 'Verified ' }); chunk(response, { content: 'answer.' }); finish(response); }
    });
    const progress = { seen: 0, started: false, streamed: '' };
    const events: ChatStreamEvent[] = [];
    const stream = agentProgress(chatAgent(settings, [lookup], 'Use sources carefully'), [new HumanMessage('Read document one')],
      new AbortController().signal, 'Local provider', progress);
    let result = await stream.next();
    while (!result.done) { events.push(result.value); result = await stream.next(); }
    expect(calls).toEqual(['one']);
    expect(requests).toHaveLength(2);
    expect(finalAnswer(result.value, 'Local provider')).toBe('Verified answer.');
    expect(requests[0]).toMatchObject({ model: 'native-fixture', stream: true });
    expect(requests[0].tools.map(item => item.function.name)).toContain('lookup_document');
    expect(requests[1].messages.find(message => message.role === 'tool')).toMatchObject({ tool_call_id: 'lookup-1', content: 'Verified source text' });
    expect(events).toContainEqual({ kind: 'step', step: { type: 'tool_start', id: 'lookup-1', name: 'lookup_document', message: 'Running lookup_document' } });
    expect(events).toContainEqual({ kind: 'step', step: { type: 'tool_end', id: 'lookup-1', name: 'lookup_document', message: 'Finished lookup_document' } });
    expect(events).toContainEqual({ kind: 'reset' });
    expect(events.filter(event => event.kind === 'text').map(event => event.content)).toEqual(['Checking the source. ', 'Verified ', 'answer.']);
  });

  it.each([
    [400, 'context_length_exceeded private-local-key', 'The request is too large for this model.'],
    [400, 'Invalid tool schema private-local-key', 'The model rejected the agent tools.'],
    [400, 'Unsupported request private-local-key', 'The model rejected this request.'],
    [401, 'Rejected private-local-key', 'The API key was rejected. Check it in Settings.'],
  ])('maps a native provider %i safely and recovers on the next request', async (status, detail, reason) => {
    let rejected = true;
    const { requests, settings } = await provider((_body, _request, response) => {
      if (rejected) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: detail, type: 'request_error' } })); return; }
      begin(response); chunk(response, { role: 'assistant', content: 'Recovered answer.' }); finish(response);
    });
    const run = chatAgent(settings, [], 'Answer safely');
    await expect(collectSnapshot(run, [new HumanMessage('Hello')], new AbortController().signal, 'Local provider'))
      .rejects.toMatchObject({ status: 502, message: `Local provider request failed (${status}). ${reason}` });
    rejected = false;
    const snapshot = await collectSnapshot(run, [new HumanMessage('Try again')], new AbortController().signal, 'Local provider');
    expect(finalAnswer(snapshot, 'Local provider')).toBe('Recovered answer.');
    expect(requests).toHaveLength(detail.startsWith('context_length') ? 3 : 2);
  });

  it('cancels an in-flight native token stream, closes its provider request and recovers', async () => {
    let stopped = false;
    let recovered = false;
    const { requests, settings } = await provider((_body, _request, response) => {
      begin(response);
      if (recovered) { chunk(response, { role: 'assistant', content: 'Recovered after Stop.' }); finish(response); return; }
      response.on('close', () => { stopped = true; });
      chunk(response, { role: 'assistant', content: 'Partial answer.' });
    });
    const run = chatAgent(settings, [], 'Answer safely');
    const controller = new AbortController();
    const stream = agentProgress(run, [new HumanMessage('Hello')], controller.signal, 'Local provider', { seen: 0, started: false, streamed: '' });
    let result = await stream.next();
    while (!result.done && result.value.kind !== 'text') result = await stream.next();
    expect(result).toMatchObject({ done: false, value: { kind: 'text', content: 'Partial answer.' } });
    controller.abort();
    expect((await stream.next()).done).toBe(true);
    await vi.waitFor(() => expect(stopped).toBe(true));
    recovered = true;
    expect(finalAnswer(await collectSnapshot(run, [new HumanMessage('Try again')], new AbortController().signal, 'Local provider'), 'Local provider'))
      .toBe('Recovered after Stop.');
    expect(requests).toHaveLength(2);
  });

  it('returns no snapshot when cancellation interrupts native non-streaming collection', async () => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const { settings } = await provider((_body, _request, response) => { begin(response); entered(); });
    const controller = new AbortController();
    const pending = collectSnapshot(chatAgent(settings, [], 'Answer safely'), [new HumanMessage('Hello')], controller.signal, 'Local provider');
    await ready;
    controller.abort();
    expect(await pending).toBeUndefined();
    const alreadyStopped = new AbortController();
    alreadyStopped.abort();
    expect(await collectSnapshot(chatAgent({ model: 'native-fixture', apiKey: 'unused' }, [], 'Prompt'), [], alreadyStopped.signal, 'Default provider'))
      .toBeUndefined();
  });

  it('uses the default installed agent through app HTTP with a native working-file backend', async () => {
    const { requests, settings } = await provider((body, _request, response) => {
      begin(response);
      if (!body.messages.some(message => message.role === 'tool')) {
        chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'download-1', type: 'function',
          function: { name: 'download_file', arguments: '{"blockId":"launch-checklist"}' } }] }, 'tool_calls');
        response.end('data: [DONE]\n\n');
      } else { chunk(response, { role: 'assistant', content: 'Downloaded the checklist for local editing.' }); finish(response); }
    });
    const root = await mkdtemp(path.join(tmpdir(), 'symbi-native-agent-http-'));
    roots.push(root);
    const store = new CanvasStore(root);
    await store.init();
    await store.updateSettings({ provider: 'custom', baseUrl: settings.baseURL, model: settings.model, apiKey: settings.apiKey });
    const before = await store.getCanvas('product-roadmap');
    const server = await createApiServer({ dataDir: root });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing app port');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: before.id, messages: [{ role: 'user', content: 'Download the launch checklist.' }] }) });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"name":"download_file","message":"Finished download_file"');
    expect(stream).toContain('Downloaded the checklist for local editing.');
    expect(await store.getCanvas(before.id)).toMatchObject(before);
    expect(requests[1].messages.find(message => message.role === 'tool')?.content).toContain('"manifestPath"');
  });
});
