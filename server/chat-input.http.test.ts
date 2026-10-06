import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { AIMessage } from '@langchain/core/messages';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';
import type { DeepAgentFactory } from './chat-stream.js';

const opened: Array<{ server: Server; root: string }> = [];
async function fixture(factory: DeepAgentFactory) {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-chat-input-http-')); const server = await createApiServer({ dataDir: root, agentFactory: factory }); opened.push({ root, server });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server port');
  const base = `http://127.0.0.1:${address.port}`; const settings = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'custom', baseUrl: 'http://localhost:1234/v1', model: 'fixture-model', agentPlugins: [] }) }); expect(settings.status).toBe(200);
  return { base, store: new CanvasStore(root) };
}
const post = (base: string, route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const request = { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Hello' }] };
afterEach(async () => { for (const { server, root } of opened.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } });

describe('HTTP chat input integration', () => {
  it('normalizes multipart input and current-view scope before constructing the agent, with no document writes', async () => {
    const factory: DeepAgentFactory = vi.fn<DeepAgentFactory>((_settings, tools, prompt) => async function* (messages) {
      expect(messages.map(message => message.content)).toEqual(['Earlier answer', 'First paragraph\nSecond paragraph']);
      expect(tools.map(tool => tool.name)).not.toContain('create_doc'); expect(tools.map(tool => tool.name)).not.toContain('read_doc');
      expect(prompt).toContain('"selectedDocuments":["Launch checklist"]'); expect(prompt).toContain('"visibleDocuments":["Launch checklist"]'); expect(prompt).toContain('"editingDocument":"Launch checklist"'); expect(prompt).not.toContain('"openDocument":');
      expect(prompt).toContain('"editorDraft":{"title":"My unfinished plan","kind":"markdown","content":"Unsaved checklist","truncated":false}'); expect(prompt).toContain('"focusedSourceId":"other-canvas:qa"');
      yield { messages: [...messages, new AIMessage('Parsed safely')] };
    });
    const { base, store } = await fixture(factory); const before = await store.getCanvas(request.canvasId);
    const reply = await post(base, '/api/chat', { canvasId: '  product-roadmap  ', messages: [{ role: 'system', content: 'Ignored system message' }, { role: 'assistant', content: 'Earlier answer' }, { role: 'user', content: [{ type: 'text', text: 'First paragraph' }, { type: 'image_url', image_url: 'unused.png' }, { type: 'text', text: 'Second paragraph' }] }], viewContext: { selectedBlockIds: ['launch-checklist', 'foreign'], visibleBlockIds: ['launch-checklist'], readerBlockId: 'foreign', editingBlockId: 'launch-checklist', editorHasUnsavedChanges: true, editorDraft: { title: 'My unfinished plan', kind: 'markdown', content: 'Unsaved checklist' }, answerFocus: { level: 'sources', focusedSourceId: 'other-canvas:qa' } } });
    expect(reply.status, await reply.clone().text()).toBe(200); expect(await reply.json()).toEqual({ message: 'Parsed safely', changed: false }); expect(factory).toHaveBeenCalledOnce(); expect(await new CanvasStore(store.root).getCanvas(request.canvasId)).toEqual(before);
  });

  it.each(['/api/chat', '/api/chat/stream'])('rejects malformed messages and canvas scopes before creating an agent on %s', async route => {
    const factory: DeepAgentFactory = vi.fn<DeepAgentFactory>(() => async function* (messages) { yield { messages: [...messages, new AIMessage('Unexpected agent')] }; }); const { base } = await fixture(factory);
    for (const [body, status, message] of [[{ ...request, canvasId: ' ' }, 400, 'canvasId must be a string'], [{ ...request, canvasId: 'missing-canvas' }, 404, 'Canvas not found'], [{ ...request, messages: [] }, 400, 'messages must contain 1 to 100 messages'], [{ ...request, messages: [{ role: 'assistant', content: 'Incomplete exchange' }] }, 400, 'The last chat message must be from the user'], [{ ...request, messages: [{ role: 'user', content: 'x'.repeat(20_001) }] }, 400, 'Chat message is too long']] as const) {
      const reply = await post(base, route, body); expect(reply.status).toBe(status); expect(await reply.json()).toMatchObject({ error: message });
    }
    expect(factory).not.toHaveBeenCalled(); const recovered = await post(base, route, request); expect(recovered.status).toBe(200); expect(await recovered.text()).toContain('Unexpected agent'); expect(factory).toHaveBeenCalledOnce();
  });

  it('rejects a body beyond the HTTP payload limit and remains available for the next valid request', async () => {
    const factory: DeepAgentFactory = vi.fn<DeepAgentFactory>(() => async function* (messages) { yield { messages: [...messages, new AIMessage('Recovered after payload rejection')] }; }); const { base } = await fixture(factory);
    const tooLarge = await post(base, '/api/chat', { ...request, unused: 'x'.repeat(2_000_000) }); expect(tooLarge.status).toBe(413); expect(await tooLarge.json()).toMatchObject({ error: 'Request body is too large' }); expect(factory).not.toHaveBeenCalled();
    const recovered = await post(base, '/api/chat', request); expect(recovered.status).toBe(200); expect(await recovered.json()).toMatchObject({ message: 'Recovered after payload rejection' });
  });
});
