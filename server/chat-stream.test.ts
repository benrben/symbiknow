import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { ApiError, CanvasStore } from './storage';
import { createApiServer } from './index';
import { createChatStream, sendChatStream, type ChatStreamSession, type DeepAgentFactory } from './chat-stream';

const directories: string[] = [];
const servers: Server[] = [];

async function storeFixture(): Promise<CanvasStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-chat-stream-'));
  directories.push(root);
  const store = new CanvasStore(root);
  await store.init();
  return store;
}

async function serverFixture(agentFactory: DeepAgentFactory): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-chat-http-'));
  directories.push(root);
  const server = await createApiServer({ dataDir: root, agentFactory });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()))));
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const body = { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Update the checklist.' }] };

describe('Deep Agent chat stream', () => {

  it('emits typed navigation when the agent opens a document or group in the native canvas', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    await store.updateBlock('product-roadmap', 'launch-checklist', { group: 'custom:launch/qa' });
    const factory: DeepAgentFactory = (_settings, tools) => async function* (messages) {
      await tools.find(item => item.name === 'show_group_on_canvas')!.invoke({ group: 'custom:launch/qa' });
      await tools.find(item => item.name === 'show_doc_on_canvas')!.invoke({ blockId: 'launch-checklist' });
      yield { messages: [...messages, new AIMessage('Opened the launch evidence.')] };
    };
    const session = await createChatStream(store, { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Open the launch checklist' }] },
      factory);
    const events: Array<{ kind: string; target?: unknown }> = [];
    for await (const event of session.events!(new AbortController().signal)) events.push(event);
    expect(events.filter(event => event.kind === 'navigate')).toEqual([
      { kind: 'navigate', target: { kind: 'group', canvasId: 'product-roadmap', group: 'custom:launch/qa', title: 'Qa' } },
      { kind: 'navigate', target: { kind: 'document', canvasId: 'product-roadmap', blockId: 'launch-checklist', title: 'Launch checklist' } },
    ]);
  });

  it('lets the agent draw a multi-block research answer with typed edges and selected-source citations', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    const factory: DeepAgentFactory = (_settings, tools) => async function* (messages) {
      await tools.find(item => item.name === 'draw_research_canvas')!.invoke({ layout: 'architecture', blocks: [
        { id: 'summary', type: 'text', title: 'Summary', content: 'Launch is blocked.', sourceIds: ['product-roadmap:launch-checklist', 'invalid:fake'] },
        { id: 'flow', type: 'diagram', title: 'Release flow', content: '```mermaid\nflowchart LR\nQA-->Release\n```', sourceIds: ['product-roadmap:launch-checklist'] },
        { id: 'next', type: 'task', title: 'Next action', content: '- [ ] Re-run QA', sourceIds: [] },
        { id: 'html', type: 'section', kind: 'html', title: 'Live page', content: '<!doctype html><html><body><h1>Launch</h1></body></html>', sourceIds: [] },
        { id: 'slides', type: 'section', kind: 'slides', title: 'Briefing', content: '---\nmarp: true\n---\n# Launch', sourceIds: [] },
        { id: 'chart', type: 'diagram', kind: 'mdx', title: 'Trend', content: '<Chart title="Tests" values="2,4" />', sourceIds: [] },
        { id: 'site', type: 'section', kind: 'website', title: 'Docs', content: '---\ngenerator: mkdocs\nsource: sites/team-docs\n---\n# Docs', sourceIds: [] },
      ], edges: [{ from: 'summary', to: 'flow', label: 'explains' }, { from: 'flow', to: 'next', label: 'unblocks' }] });
      yield { messages: [...messages, new AIMessage('I mapped the release evidence.')] };
    };
    const session = await createChatStream(store, { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'What blocks launch?' }] }, factory);
    const events: Array<{ kind: string; patch?: { blocks: Array<{ sourceIds: string[]; kind?: string; content: string }>; edges: unknown[] } }> = [];
    for await (const event of session.events!(new AbortController().signal)) events.push(event);
    const patch = events.find(event => event.kind === 'research_patch')?.patch;
    expect(patch?.blocks).toHaveLength(7);
    expect(patch?.blocks[0].sourceIds).toEqual(['product-roadmap:launch-checklist']);
    expect(patch?.blocks[3]).toMatchObject({ kind: 'markdown', content: expect.stringContaining('format: html') });
    expect(patch?.blocks.slice(4).map(block => block.kind)).toEqual(['slides', 'mdx', 'website']);
    expect(patch?.edges).toHaveLength(2);
  });

  it('answers a direct question in chat without offering the research drawing tool', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    let offered: string[] = [];
    const factory: DeepAgentFactory = (_settings, tools) => async function* (messages) {
      offered = tools.map(item => item.name);
      yield { messages: [...messages, new AIMessage('The two mobile tests failed.')] };
    };
    const session = await createChatStream(store, { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Which tests failed?' }] }, factory);
    const events = [];
    for await (const event of session.events!(new AbortController().signal)) events.push(event);
    expect(offered).not.toContain('draw_research_canvas');
    expect(events.some(event => event.kind === 'answer_canvas' || event.kind === 'research_patch')).toBe(false);
    expect(events.some(event => event.kind === 'text' && event.content.includes('two mobile tests'))).toBe(true);
  });

  it('offers create and typed linking together after an explicit gap draft approval', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    let offered: string[] = [];
    const factory: DeepAgentFactory = (_settings, tools) => {
      offered = tools.map(item => item.name);
      return async function* (messages) { yield { messages: [...messages, new AIMessage('Ready to save the draft.')] }; };
    };
    const session = await createChatStream(store, { ...body, messages: [{ role: 'user', content: 'Create the approved draft and link it as a prerequisite.' }] }, factory);
    for await (const piece of session.tokens(new AbortController().signal)) { void piece; }
    expect(offered).toContain('create_doc');
    expect(offered).toContain('link_blocks');
  });

  it('uses the current unsaved draft for advice and refuses to overwrite its saved document', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    const original = (await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'launch-checklist')!.content;
    const factory: DeepAgentFactory = (_settings, tools, prompt) => async function* (messages) {
      expect(prompt).toContain('My unfinished checklist');
      expect(prompt).toContain('Propose changes in chat');
      await expect(tools.find(item => item.name === 'edit_doc')!.invoke({
        blockId: 'launch-checklist', content: '# Replaced',
      })).rejects.toMatchObject({ status: 409 });
      yield { messages: [...messages, new AIMessage('Your draft needs a clearer first step.')] };
    };
    const session = await createChatStream(store, { ...body,
      viewContext: { selectedBlockIds: ['launch-checklist'], readerBlockId: 'launch-checklist',
        editingBlockId: 'launch-checklist', editorHasUnsavedChanges: true,
        editorDraft: { title: 'Launch checklist', kind: 'markdown', content: '# My unfinished checklist' } },
    }, factory);
    for await (const chunk of session.tokens(new AbortController().signal)) { void chunk; }
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'launch-checklist')!.content).toBe(original);
  });

  it('uses the selected agent profile and only the enabled plugin tools', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'private-key', model: 'vendor/model', agentProfile: 'research', agentPlugins: ['document_read'] });
    let names: string[] = [];
    let prompt = '';
    const factory: DeepAgentFactory = (_settings, tools, systemPrompt) => {
      names = tools.map(item => item.name);
      prompt = systemPrompt;
      return async function* (messages) { yield { messages: [...messages, new AIMessage('I found the document.')] }; };
    };
    const session = await createChatStream(store, body, factory);
    const chunks: string[] = [];
    for await (const chunk of session.tokens(new AbortController().signal)) chunks.push(chunk);
    expect(chunks.join('')).toBe('I found the document.');
    expect(names).toEqual(['search_docs', 'read_doc', 'show_doc_on_canvas', 'show_group_on_canvas',
      'jev_profile', 'find_by', 'related', 'memory_map', 'jev_activity', 'brain_inbox']);
    expect(prompt).toContain('Investigate relevant documents');
  });

  it('rejects invalid history, absent credentials, and missing canvases before starting', async () => {
    const store = await storeFixture();
    const unused: DeepAgentFactory = () => { throw new Error('Should not create an agent'); };
    await expect(createChatStream(store, body, unused)).rejects.toMatchObject({ status: 400, message: 'Set an OpenRouter API key in Settings before using chat' });
    await store.updateSettings({ apiKey: 'key' });
    await expect(createChatStream(store, body, unused)).rejects.toMatchObject({ status: 400, message: 'Set an OpenRouter model in Settings before using chat' });
    await store.updateSettings({ model: 'vendor/model' });
    await expect(createChatStream(store, { ...body, canvasId: 'missing' }, unused)).rejects.toMatchObject({ status: 404 });
    await expect(createChatStream(store, { ...body, messages: [] }, unused)).rejects.toMatchObject({ status: 400 });
    await expect(createChatStream(store, { ...body, messages: [{ role: 'assistant', content: 'No user' }] }, unused))
      .rejects.toMatchObject({ status: 400, message: 'The last chat message must be from the user' });
    await expect(createChatStream(store, { ...body, messages: [{ role: 'user', content: 'x'.repeat(20_001) }] }, unused))
      .rejects.toMatchObject({ status: 400, message: 'Chat message is too long' });
  });

  it('serves OpenAI-compatible SSE with a stop chunk and JSON settings errors', async () => {
    const factory: DeepAgentFactory = () => async function* (messages) {
      yield { messages: [...messages, new AIMessage('Here is the answer.')] };
    };
    const base = await serverFixture(factory);
    const post = (route: string, value: unknown) => fetch(base + route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    const missingKey = await post('/api/chat/stream', body);
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toEqual({ error: 'Set an OpenRouter API key in Settings before using chat' });
    await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'private-key', model: 'vendor/model' }) });
    const response = await post('/api/chat/stream', body);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = (await response.text()).split('\n\n').filter(event => event.startsWith('data: ')).map(event => event.replace(/^data: /, ''));
    expect(JSON.parse(events[0]).choices[0].delta.content).toBe('Here is the answer.');
    expect(JSON.parse(events[1]).choices[0].finish_reason).toBe('stop');
    expect(events[2]).toBe('[DONE]');
  });

  it('streams safe tool progress frames beside compatible answer chunks', async () => {
    const factory: DeepAgentFactory = () => async function* (messages) {
      const call = new AIMessage({ content: '', tool_calls: [{ id: 'call-1', name: 'search_docs', args: { query: 'private query' } }] });
      yield { messages: [...messages, call] };
      yield { messages: [...messages, call, new ToolMessage({ content: 'private document body', tool_call_id: 'call-1', name: 'search_docs' })] };
      yield { messages: [...messages, call, new ToolMessage({ content: 'private document body', tool_call_id: 'call-1', name: 'search_docs' }),
        new AIMessage('I found the document.')] };
    };
    const base = await serverFixture(factory);
    await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'private-openrouter-key', model: 'vendor/model' }) });
    const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const stream = await response.text();
    const frames = stream.split('\n\n').filter(Boolean);
    const steps = frames.filter(frame => frame.startsWith('event: agent_step\n')).map(frame => JSON.parse(frame.split('data: ')[1]) as { type: string; id?: string; name?: string; message: string });
    expect(response.status).toBe(200);
    expect(steps).toEqual([
      { type: 'thinking', message: 'Working on your request' },
      { type: 'tool_start', id: 'call-1', name: 'search_docs', message: 'Running search_docs' },
      { type: 'tool_end', id: 'call-1', name: 'search_docs', message: 'Finished search_docs' },
      { type: 'thinking', message: 'Reviewing the tool result' },
    ]);
    expect(frames.some(frame => frame.includes('"content":"I found the document."'))).toBe(true);
    expect(frames.at(-1)).toBe('data: [DONE]');
    expect(stream).not.toMatch(/private query|private document body|private-openrouter-key/);
  });

  it('sanitizes tool labels and handles partial Deep Agents snapshots', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'openrouter-key', model: 'vendor/model' });
    const factory: DeepAgentFactory = () => async function* (messages) {
      yield {};
      const planning = new AIMessage('Planning');
      planning.tool_calls = undefined;
      yield { messages: [...messages, planning] };
      const call = new AIMessage({ content: '', tool_calls: [{ id: 'tool-2', name: '<>', args: {} }] });
      yield { messages: [...messages, planning, call] };
      yield { messages: [...messages, planning, call, new ToolMessage({ content: 'hidden', tool_call_id: 'tool-2' })] };
      yield { messages: [...messages, planning, call, new ToolMessage({ content: 'hidden', tool_call_id: 'tool-2' }), new AIMessage('Done.')] };
    };
    const session = await createChatStream(store, body, factory);
    const events = [];
    for await (const event of session.events!(new AbortController().signal)) events.push(event);
    expect(events.filter(event => event.kind === 'step')).toEqual([
      { kind: 'step', step: { type: 'thinking', message: 'Working on your request' } },
      { kind: 'step', step: { type: 'tool_start', id: 'tool-2', name: 'tool', message: 'Running tool' } },
      { kind: 'step', step: { type: 'tool_end', id: 'tool-2', name: 'tool', message: 'Finished tool' } },
      { kind: 'step', step: { type: 'thinking', message: 'Reviewing the tool result' } },
    ]);
    expect(events.filter(event => event.kind === 'text').at(-1)).toEqual({ kind: 'text', content: 'Done.' });
    expect(events.at(-1)).toEqual({ kind: 'text', content: 'Done.' });
    expect(events.some(event => String(event.kind).includes('verification'))).toBe(false);
  });

  it('stops rich progress when its agent is canceled during snapshots or an upstream failure', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'openrouter-key', model: 'vendor/model' });
    const afterSnapshot = new AbortController();
    const snapshotFactory: DeepAgentFactory = () => async function* (messages) {
      yield { messages };
      afterSnapshot.abort();
      yield { messages: [...messages, new AIMessage('Hidden')] };
    };
    const session = await createChatStream(store, body, snapshotFactory);
    const events = [];
    for await (const event of session.events!(afterSnapshot.signal)) events.push(event);
    expect(events).toEqual([{ kind: 'step', step: { type: 'thinking', message: 'Working on your request' } }]);

    const duringFailure = new AbortController();
    const failureFactory: DeepAgentFactory = () => async function* () {
      duringFailure.abort();
      throw new Error('Private upstream details');
    };
    const failed = await createChatStream(store, body, failureFactory);
    const failureEvents = [];
    for await (const event of failed.events!(duringFailure.signal)) failureEvents.push(event);
    expect(failureEvents).toEqual([]);
  });

  it('keeps API errors readable after headers and closes empty streams cleanly', async () => {
    const sessions: ChatStreamSession[] = [
      { model: 'vendor/model', async *tokens() { yield 'Beginning. '; throw new ApiError(502, 'Tool call limit reached'); } },
      { model: 'vendor/model', async *tokens() { return; } },
    ];
    const server = createServer((_request, response) => { void sendChatStream(response, sessions.shift()!); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const base = `http://127.0.0.1:${address.port}`;
    const failed = await fetch(base).then(response => response.text());
    expect(failed).toContain('event: error\ndata: {"message":"Tool call limit reached"}');
    const empty = await fetch(base).then(response => response.text());
    expect(empty).toContain('"finish_reason":"stop"');
    expect(empty).toContain('data: [DONE]');
  });

  it('stops processing Deep Agent snapshots after cancellation', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    const signal = new AbortController();
    const factory: DeepAgentFactory = () => async function* () {
      signal.abort();
      yield { messages: [new AIMessage('Should remain hidden')] };
    };
    const session = await createChatStream(store, body, factory);
    const chunks: string[] = [];
    for await (const chunk of session.tokens(signal.signal)) chunks.push(chunk);
    expect(chunks).toEqual([]);

    const caught = new AbortController();
    const failing: DeepAgentFactory = () => async function* () {
      caught.abort();
      throw new Error('Abort');
    };
    const interrupted = await createChatStream(store, body, failing);
    for await (const chunk of interrupted.tokens(caught.signal)) chunks.push(chunk);
    expect(chunks).toEqual([]);
  });
});
