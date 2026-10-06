import { expectRestoredCanvas } from './tests/restoration.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { chat } from './chat.js';
import { CanvasStore } from './storage.js';
import { getChatProposal } from './chat-proposals.js';
import { answer, begin, chunk, fixture, nextRequest, toolCalls } from './chat-session.test.fixture.js';

const body = { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Update the launch checklist.' }] };

async function post(base: string, route: string, input: unknown = {}) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}

it('uses default options and the installed native agent while excluding concurrent advisory locks from changed', async () => {
  const setup = await fixture();
  setup.model.handle = async (_request, response) => {
    await setup.store.lockBlock(body.canvasId, 'launch-checklist', 'Reviewer', {});
    answer(response, ['Release ', 'answer.']);
  };
  expect(await chat(setup.store, { ...body, messages: [{ role: 'user', content: 'Hello' }] }))
    .toEqual({ message: 'Release answer.', changed: false });
  expect(setup.model.requests).toHaveLength(1);
  expect(setup.model.requests[0]).toMatchObject({ url: '/v1/chat/completions', authorization: 'Bearer local-model-secret',
    body: { model: 'native-session', stream: true } });
  expect((await setup.store.getCanvas(body.canvasId)).blocks.find(block => block.id === 'launch-checklist')?.lock)
    .toMatchObject({ owner: 'Reviewer' });
});

it('resets native preliminary text, ignores progress/navigation events, and returns a persisted review proposal through JSON HTTP', async () => {
  const setup = await fixture();
  setup.model.handle = (request, response) => {
    if (request.messages.some(message => message.role === 'tool')) { answer(response, ['Review the ', 'proposed checklist.']); return; }
    toolCalls(response, [
      { name: 'read_doc', args: { blockId: 'launch-checklist' } },
      { name: 'edit_doc', args: { blockId: 'launch-checklist', content: '# Native JSON reviewed checklist' } },
      { name: 'show_doc_on_canvas', args: { blockId: 'launch-checklist' } },
    ], 'Preliminary thought that must be reset. ');
  };
  const base = await setup.app();
  const response = await post(base, '/api/chat', body);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ message: 'Review the proposed checklist.', changed: false, proposalId: expect.any(String) });
  expect(await new CanvasStore(setup.root).getCanvas(body.canvasId)).toEqual(setup.canvas);
  const proposal = getChatProposal(new CanvasStore(setup.root), response.body.proposalId);
  expect(proposal).toMatchObject({ status: 'pending', changes: [{ type: 'edit', blockId: 'launch-checklist', canApply: true }] });
  expect(await readFile(path.join(setup.root, 'chat-proposals', response.body.proposalId + '.json'), 'utf8')).toContain('# Native JSON reviewed checklist');
  expect(setup.model.requests).toHaveLength(2);
  expect(setup.model.requests[1].body.messages.filter(message => message.role === 'tool')).toHaveLength(3);
  expect((await post(base, `/api/chat/proposals/${response.body.proposalId}/apply`)).status).toBe(200);
  expect((await new CanvasStore(setup.root).getCanvas(body.canvasId)).blocks.find(block => block.id === 'launch-checklist')?.content)
    .toBe('# Native JSON reviewed checklist');
  expect((await post(base, `/api/chat/proposals/${response.body.proposalId}/undo`)).status).toBe(200);
  expectRestoredCanvas(await new CanvasStore(setup.root).getCanvas(body.canvasId), setup.canvas);
});

it('does not offer task tools to the native assistant', async () => {
  const setup = await fixture();
  setup.model.handle = (_request, response) => answer(response, ['I can help with documents.']);
  const base = await setup.app();
  expect(await post(base, '/api/chat', { ...body, messages: [{ role: 'user', content: 'Hello' }] }))
    .toEqual({ status: 200, body: { message: 'I can help with documents.', changed: false } });
  expect(setup.model.requests[0].body.tools.map(tool => tool.function.name))
    .not.toEqual(expect.arrayContaining(['list_tasks', 'create_task', 'update_task', 'delete_task']));
});

it('maps a real model rejection safely through JSON HTTP and recovers on the same provider without source writes', async () => {
  const setup = await fixture();
  setup.model.handle = (_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Rejected local-model-secret', type: 'request_error' } }));
  };
  const base = await setup.app();
  const failed = await post(base, '/api/chat', body);
  expect(failed.status).toBe(502);
  expect(failed.body.error).toContain('The API key was rejected. Check it in Settings.');
  expect(JSON.stringify(failed.body)).not.toContain('local-model-secret');
  expect(await new CanvasStore(setup.root).getCanvas(body.canvasId)).toEqual(setup.canvas);
  setup.model.handle = (_request, response) => answer(response, ['Recovered JSON answer.']);
  expect(await post(base, '/api/chat', body)).toEqual({ status: 200, body: { message: 'Recovered JSON answer.', changed: false } });
  expect(setup.model.requests).toHaveLength(2);
});

it('throws cancellation for a real in-flight native provider stream and starts a fresh public chat successfully', async () => {
  const setup = await fixture();
  setup.model.handle = (_request, response) => { begin(response); chunk(response, { role: 'assistant', content: 'Partial answer.' }); };
  const controller = new AbortController();
  const entered = nextRequest(setup.model);
  const pending = chat(setup.store, body, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await entered;
  controller.abort();
  await rejected;
  await vi.waitFor(() => expect(setup.model.closed).toBe(1));
  expect(await new CanvasStore(setup.root).getCanvas(body.canvasId)).toEqual(setup.canvas);
  setup.model.handle = (_request, response) => answer(response, ['Recovered after cancellation.']);
  expect(await chat(setup.store, body)).toEqual({ message: 'Recovered after cancellation.', changed: false });
  expect(setup.model.requests).toHaveLength(2);
});

it('rejects public invalid messages and already stopped requests before either native provider runs', async () => {
  const setup = await fixture();
  await expect(chat(setup.store, { ...body, messages: [] })).rejects.toMatchObject({ status: 400, message: 'messages must contain 1 to 100 messages' });
  const controller = new AbortController();
  controller.abort();
  await expect(chat(setup.store, body, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(setup.model.requests).toEqual([]);
});
