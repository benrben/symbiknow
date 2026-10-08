import { describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import type { DeepAgentFactory } from './chat-stream.js';
import { CanvasStore } from './storage.js';
import { chatHttpFixture, jsonRequest } from './api-chat.test.fixture.js';

describe('HTTP search and chat roots', () => {
  it('uses empty-query and ordinary search defaults and falls through unknown chat paths', async () => {
    const { base, store } = await chatHttpFixture();
    const empty = await fetch(base + '/api/search');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual(await store.search(''));
    const created = await store.createBlock('product-roadmap', { title: 'HTTP searchable proof', content: 'Boundary lookup needle.' });
    const query = 'Boundary lookup needle';
    const ordinary = await fetch(base + '/api/search?q=' + encodeURIComponent(query) + '&rank=other');
    expect(ordinary.status).toBe(200);
    const hits = await ordinary.json();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ canvasId: 'product-roadmap', blockId: created.id, title: created.title,
      kind: 'markdown', matchIn: 'body', excerpt: created.content,
      evidence: { documentId: created.id, contentHash: created.contentHash, claim: query,
        passage: created.content, passageKind: 'exact' } });
    expect(hits[0].evidence.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const route of ['/api/chat/unknown', '/api/investigations/extra/path']) {
      const unknown = await fetch(base + route);
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: 'Route not found' });
    }
  });

  it('passes HTTP messages to the actual scoped tools and emits matching JSON and streaming answers', async () => {
    const factory: DeepAgentFactory = vi.fn<DeepAgentFactory>((_settings, tools, prompt) => async function* (messages) {
      expect(prompt).toContain('The active canvas ID is product-roadmap.');
      expect(messages.map(message => message.content)).toEqual(['Earlier question', 'Earlier answer', 'Read the launch checklist']);
      expect(tools.map(tool => tool.name)).not.toContain('edit_doc');
      const read = tools.find(tool => tool.name === 'read_doc');
      if (!read) throw new Error('Missing real read tool');
      const result = JSON.parse(String(await read.invoke({ blockId: 'launch-checklist' })));
      expect(result).toMatchObject({ title: 'Launch checklist', content: expect.stringContaining('beta') });
      yield { messages: [...messages, new AIMessage('Read via HTTP tool.')] };
    });
    const { base, root, store } = await chatHttpFixture({ agentFactory: factory });
    await store.updateSettings({ agentPlugins: ['external_mcp'] });
    await store.ensureJevStamps('product-roadmap');
    const before = await store.getCanvas('product-roadmap');
    const body = { canvasId: before.id, messages: [{ role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' }, { role: 'user', content: 'Read the launch checklist' }] };
    const json = await jsonRequest(base, '/api/chat', body);
    expect(json.status, await json.clone().text()).toBe(200);
    expect(await json.json()).toEqual({ message: 'Read via HTTP tool.', changed: false });
    const stream = await jsonRequest(base, '/api/chat/stream', body);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const events = await stream.text();
    expect(events).toContain('Read via HTTP tool.');
    expect(events).toContain('data: [DONE]');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(await new CanvasStore(root).getCanvas(before.id)).toEqual(before);
  });
});
