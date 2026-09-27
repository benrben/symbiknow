import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chat } from './chat.js';
import { ApiError, CanvasStore } from './storage.js';

const directories: string[] = [];
const userMessage = { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Help with the launch.' }] };

async function freshStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-chat-'));
  directories.push(directory);
  const store = new CanvasStore(directory);
  await store.init();
  return store;
}

async function storeWithSettings(model = 'vendor/tool-model', apiKey = 'private-key') {
  const store = await freshStore();
  await store.updateSettings({ model, apiKey });
  return store;
}

function completion(message: Record<string, unknown>): Response {
  return Response.json({ choices: [{ message }] });
}

function tool(name: string, args: unknown, id = name) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('OpenRouter chat', () => {
  it('executes search, read, create, edit, move and link tools, then reports persisted changes', async () => {
    const store = await storeWithSettings();
    const observed: Array<{ model: string; messages: Array<{ role: string; content: string; tool_call_id?: string }> }> = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as typeof observed[number];
      observed.push(request);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer private-key' });
      if (observed.length === 1) return completion({ content: null, tool_calls: [
        tool('search_docs', { query: 'checklist' }),
        tool('read_doc', { blockId: 'roadmap-overview' }),
        tool('create_doc', { title: 'Agent plan', content: '# Initial', x: 240, y: 120 }),
      ] });
      if (observed.length === 2) {
        const results = request.messages.filter(message => message.role === 'tool');
        expect(results).toHaveLength(3);
        expect(results[0].content).toContain('launch-checklist');
        expect(results[1].content).toContain('Roadmap overview');
        const created = JSON.parse(results[2].content) as { id: string };
        return completion({ content: 'Making the final changes.', tool_calls: [
          tool('edit_doc', { blockId: created.id, content: '# Final plan' }),
          tool('move_block', { blockId: created.id, x: 600, y: 330 }),
          tool('link_blocks', { fromBlockId: created.id, toBlockId: 'roadmap-overview' }),
        ] });
      }
      expect(request.messages.filter(message => message.role === 'tool')).toHaveLength(6);
      return completion({ content: 'Created and linked the plan.' });
    }) as typeof fetch;

    expect(await chat(store, userMessage, fetcher)).toEqual({ message: 'Created and linked the plan.', changed: true });
    expect(observed).toHaveLength(3);
    const canvas = await store.getCanvas('product-roadmap');
    expect(canvas.blocks.find(block => block.title === 'Agent plan')).toMatchObject({
      content: '# Final plan', x: 600, y: 330, links: ['roadmap-overview'],
    });
  });

  it('passes tool errors back to the model and can still return an answer', async () => {
    const store = await storeWithSettings();
    let count = 0;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      count++;
      if (count === 1) return completion({ content: null, tool_calls: [
        tool('unknown_tool', {}),
        tool('read_doc', { blockId: 'missing-block' }),
        tool('search_docs', { query: 3 }),
        tool('link_blocks', { fromBlockId: 'missing-block', toBlockId: 'roadmap-overview' }),
        tool('search_docs', []),
        { ...tool('search_docs', {}), function: { name: 'search_docs', arguments: '' } },
      ] });
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const errors = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content) as { error: string });
      expect(errors).toEqual([
        { error: 'Unknown tool: unknown_tool' },
        { error: 'Block not found' },
        { error: 'query must be a string' },
        { error: 'Source block not found' },
        { error: 'Expected an object' },
        { error: 'query must be a string' },
      ]);
      return completion({ content: 'I could not complete those tools.' });
    }) as typeof fetch;
    expect(await chat(store, userMessage, fetcher)).toEqual({ message: 'I could not complete those tools.', changed: false });
  });

  it('redacts the configured key from OpenRouter error messages', async () => {
    const store = await storeWithSettings();
    const fetcher = vi.fn(async () => Response.json({ error: { message: 'Rejected private-key' } }, { status: 401 })) as typeof fetch;
    await expect(chat(store, userMessage, fetcher)).rejects.toMatchObject({
      status: 502, message: 'OpenRouter request failed (401): Rejected [redacted]',
    });
  });

  it('handles an upstream error without a JSON body and a network failure', async () => {
    const store = await storeWithSettings();
    const badBody = vi.fn(async () => new Response('Unavailable', { status: 503 })) as typeof fetch;
    await expect(chat(store, userMessage, badBody)).rejects.toMatchObject({
      status: 502, message: 'OpenRouter request failed (503)',
    });
    const offline = vi.fn(async () => { throw new Error('network offline'); }) as typeof fetch;
    await expect(chat(store, userMessage, offline)).rejects.toMatchObject({
      status: 502, message: 'Could not reach OpenRouter',
    });
  });

  it('handles plain OpenRouter error JSON and missing error text', async () => {
    const store = await storeWithSettings();
    const plainError = vi.fn(async () => Response.json({ message: 'Access denied' }, { status: 403 })) as typeof fetch;
    await expect(chat(store, userMessage, plainError)).rejects.toMatchObject({ status: 502, message: 'OpenRouter request failed (403): Access denied' });
    const noMessage = vi.fn(async () => Response.json({ error: {} }, { status: 503 })) as typeof fetch;
    await expect(chat(store, userMessage, noMessage)).rejects.toMatchObject({ status: 502, message: 'OpenRouter request failed (503)' });
  });

  it('converts a non-Error tool rejection into a readable tool result', async () => {
    const store = await storeWithSettings();
    vi.spyOn(store, 'search').mockRejectedValue('unexpected rejection');
    let count = 0;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      count++;
      if (count === 1) return completion({ content: null, tool_calls: [tool('search_docs', { query: 'launch' })] });
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      expect(JSON.parse(request.messages.at(-1)?.content ?? '{}')).toEqual({ error: 'Tool failed' });
      return completion({ content: 'Search is unavailable.' });
    }) as typeof fetch;
    expect(await chat(store, userMessage, fetcher)).toEqual({ message: 'Search is unavailable.', changed: false });
  });

  it.each([
    ['invalid JSON', new Response('{', { status: 200 }), 'OpenRouter returned an invalid response'],
    ['missing message', Response.json({ choices: [] }), 'OpenRouter returned no message'],
    ['non-array choices', Response.json({ choices: {} }), 'OpenRouter returned no message'],
    ['missing text', completion({ content: null }), 'OpenRouter returned no text'],
    ['invalid tool call', completion({ content: null, tool_calls: [{ id: 'broken', type: 'function' }] }), 'OpenRouter returned an invalid tool call'],
    ['null tool call', completion({ content: null, tool_calls: [null] }), 'OpenRouter returned an invalid tool call'],
  ])('rejects %s from the model', async (_case, response, message) => {
    const store = await storeWithSettings();
    const fetcher = vi.fn(async () => response) as typeof fetch;
    await expect(chat(store, userMessage, fetcher)).rejects.toMatchObject({ status: 502, message });
  });

  it('stops after eight rounds of tool calls', async () => {
    const store = await storeWithSettings();
    const fetcher = vi.fn(async () => completion({ content: null, tool_calls: [tool('search_docs', { query: 'launch' })] })) as typeof fetch;
    await expect(chat(store, userMessage, fetcher, 8)).rejects.toMatchObject({ status: 502, message: 'OpenRouter exceeded the tool call limit' });
    expect(fetcher).toHaveBeenCalledTimes(9);
  });

  it('allows more than eight tool calls with the production limit', async () => {
    const store = await storeWithSettings();
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      return calls <= 9
        ? completion({ content: null, tool_calls: [tool('unknown_tool', {}, String(calls))] })
        : completion({ content: 'Finished.' });
    }) as typeof fetch;
    expect(await chat(store, userMessage, fetcher)).toEqual({ message: 'Finished.', changed: false });
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it('allows a model response with more than eight tool calls', async () => {
    const store = await storeWithSettings();
    let requests = 0;
    const fetcher = vi.fn(async () => {
      requests++;
      return requests === 1
        ? completion({ content: null, tool_calls: Array.from({ length: 9 }, (_, index) => tool('unknown_tool', {}, String(index))) })
        : completion({ content: 'Finished.' });
    }) as typeof fetch;
    expect(await chat(store, userMessage, fetcher)).toEqual({ message: 'Finished.', changed: false });
  });

  it('validates the canvas, message history and Settings before calling OpenRouter', async () => {
    const store = await storeWithSettings();
    const fetcher = vi.fn(async () => completion({ content: 'Never requested.' })) as typeof fetch;
    await expect(chat(store, { canvasId: 'missing', messages: userMessage.messages }, fetcher)).rejects.toBeInstanceOf(ApiError);
    await expect(chat(store, { canvasId: 'product-roadmap', messages: [] }, fetcher)).rejects.toMatchObject({ status: 400 });
    await expect(chat(store, { canvasId: 'product-roadmap', messages: [{ role: 'tool', content: 'bad' }] }, fetcher)).rejects.toMatchObject({ status: 400 });
    await expect(chat(store, { canvasId: 'product-roadmap', messages: [null] }, fetcher)).rejects.toMatchObject({ status: 400 });
    await store.updateSettings({ apiKey: '', model: 'vendor/tool-model' });
    await expect(chat(store, userMessage, fetcher)).rejects.toMatchObject({ status: 400, message: 'Set an OpenRouter API key in Settings before using chat' });
    const noModel = await freshStore();
    await noModel.updateSettings({ apiKey: 'private-key' });
    await expect(chat(noModel, userMessage, fetcher)).rejects.toMatchObject({ status: 400, message: 'Set an OpenRouter model in Settings before using chat' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
