import { afterEach, describe, expect, it, vi } from 'vitest';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createChatStream } from './chat-stream.js';
import { chatAgent } from './chat-agent.js';
import { preparedChatStream } from './chat-stream-preparation.js';
import { agentConfiguration, requestContext } from './chat-stream-context.js';
import { CanvasStore } from './storage.js';
import { answer, events, fixture, tokens, toolCalls } from './chat-session.test.fixture.js';
import { notebook } from './chat-stream.test.fixture.js';

afterEach(() => vi.restoreAllMocks());

describe('native chat stream preparation boundaries', () => {

  it('keeps document retrieval disabled over native HTTP and restores local sources after the plugin is enabled', async () => {
    const setup = await fixture();
    await setup.store.updateSettings({ agentPlugins: ['tasks'] });
    const base = await setup.app();
    const body = { canvasId: setup.canvas.id, messages: [{ role: 'user', content: 'What blocks the launch?' }] };
    const post = () => fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await post();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('The release ');
    expect(text).not.toContain('event: answer_canvas');
    expect(text).not.toContain('event: research_canvas_patch');
    const names = setup.model.requests[0].body.tools.map(tool => tool.function.name);
    expect(names).toContain('create_task');
    for (const name of ['read_doc', 'search_docs', 'draw_research_canvas']) expect(names).not.toContain(name);
    expect((await new CanvasStore(setup.root).getSettings()).agentPlugins).toEqual(['tasks']);
    expect((await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentPlugins: ['document_read'] }) })).status).toBe(200);
    const recovered = await post();
    expect(recovered.status).toBe(200);
    const recoveredText = await recovered.text();
    expect(recoveredText).toContain('event: answer_canvas');
    expect(recoveredText).toContain('"selection":"local"');
    expect(recoveredText).toContain('"blockId":"launch-checklist"');
    expect(setup.model.requests[1].body.tools.map(tool => tool.function.name)).toContain('read_doc');
    expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
  });

  it('skips disabled native MCP servers while retaining actual assistant conversation messages', async () => {
    const setup = await fixture();
    const remote = await notebook(setup.root);
    await setup.store.updateSettings({ mcpServers: [{ ...remote.config, enabled: false }] });
    const session = await createChatStream(setup.store, { canvasId: setup.canvas.id, messages: [
      { role: 'user', content: 'I need help reviewing the launch.' },
      { role: 'assistant', content: 'Which source should I review?' },
      { role: 'user', content: 'Review the release.' },
    ] });
    expect((await tokens(session)).join('')).toBe('The release requires QA approval.');
    expect(remote.boundary.requests).toEqual([]);
    expect(setup.model.requests[0].body.messages).toContainEqual({ role: 'assistant', content: 'Which source should I review?' });
  });

  it('loads a public native MCP connection after reopening valid legacy settings without optional secrets', async () => {
    const setup = await fixture();
    const remote = await notebook(setup.root);
    await setup.store.updateSettings({ mcpServers: [remote.config] });
    const saved = await setup.store.secretSettings();
    delete saved.secrets; // PrivateSettings permits old files without this optional field.
    await writeFile(path.join(setup.root, 'settings.json'), JSON.stringify(saved));
    const restarted = new CanvasStore(setup.root);
    expect((await restarted.getSettings()).secretNames).toEqual([]);
    setup.model.handle = (request, response) => {
      if (request.messages.some(message => message.role === 'tool')) { answer(response); return; }
      toolCalls(response, [{ name: 'notes__read_note', args: {} }]);
    };
    const session = await createChatStream(restarted, { canvasId: setup.canvas.id,
      messages: [{ role: 'user', content: 'Review the connected notebook.' }] });
    expect((await tokens(session)).join('')).toBe('The release requires QA approval.');
    expect(remote.boundary.calls).toEqual(['read_note']);
    expect(remote.boundary.requests.every(request => request.authorization === undefined)).toBe(true);
    expect(setup.model.requests[1].body.messages.find(message => message.role === 'tool')?.content)
      .toBe(await readFile(remote.notebookFile, 'utf8'));
    await vi.waitFor(() => expect(remote.boundary.streams.size).toBe(0));
    expect(await restarted.getCanvas(setup.canvas.id)).toEqual(setup.canvas);
  });

  it('imports real SDK MCP tools, forwards saved authentication, and persists a requested remote write through the installed agent', async () => {
    const setup = await fixture();
    const remote = await notebook(setup.root);
    await setup.store.updateSettings({ secrets: { NOTE_KEY: 'native-notebook-secret' },
      mcpServers: [{ ...remote.config, bearerSecret: 'NOTE_KEY' }] });
    setup.model.handle = (request, response) => {
      if (request.messages.some(message => message.role === 'tool')) { answer(response, ['The connected notebook was updated.']); return; }
      toolCalls(response, [{ name: 'notes__write_note', args: { text: 'Reviewed native notebook update.' } },
        { name: 'notes__read_note', args: {} }]);
    };
    const base = await setup.app();
    const response = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: setup.canvas.id, messages: [{ role: 'user', content: 'Update the connected notebook to say Reviewed native notebook update.' }] }) });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"name":"notes__write_note","message":"Running notes__write_note"');
    expect(stream).toContain('"name":"notes__read_note","message":"Finished notes__read_note"');
    expect(stream).toContain('The connected notebook was updated.');
    expect(await readFile(remote.notebookFile, 'utf8')).toBe('Reviewed native notebook update.');
    expect(remote.boundary.calls).toEqual(['write_note', 'read_note']);
    expect(remote.boundary.requests.filter(request => request.rpc === 'tools/call')).toHaveLength(2);
    expect(remote.boundary.requests.every(request => request.authorization === 'Bearer native-notebook-secret')).toBe(true);
    const first = setup.model.requests[0].body;
    expect(first.tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['notes__read_note', 'notes__write_note']));
    expect(JSON.stringify(first.messages)).toContain('Tools whose names start with an MCP server ID come from outside MCP servers the user connected.');
    expect(JSON.stringify(first.messages)).not.toContain('native-notebook-secret');
    await vi.waitFor(() => expect(remote.boundary.streams.size).toBe(0));
    expect(remote.boundary.closedStreams).toBeGreaterThan(0);
    expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
  });

  it.each(['connect', 'discovery'] as const)('surfaces a native MCP %s failure before model progress and recovers after repair', async failure => {
    const setup = await fixture();
    const remote = await notebook(setup.root);
    remote.boundary.rejectConnect = failure === 'connect';
    remote.boundary.rejectListing = failure === 'discovery';
    await setup.store.updateSettings({ mcpServers: [remote.config] });
    const request = { canvasId: setup.canvas.id, messages: [{ role: 'user', content: 'Review the release.' }] };
    const session = await createChatStream(setup.store, request);
    const output = await events(session);
    expect(output[0]).toMatchObject({ kind: 'step', step: { type: 'thinking', message: expect.stringMatching(/^Connected notebook is unavailable:/) } });
    expect(output[1]).toMatchObject({ kind: 'step', step: { type: 'thinking', message: 'Working on your request' } });
    expect(output.filter(event => event.kind === 'text').map(event => event.content).join('')).toBe('The release requires QA approval.');
    expect(setup.model.requests[0].body.tools.map(tool => tool.function.name)).not.toContain('notes__read_note');
    remote.boundary.rejectConnect = false;
    remote.boundary.rejectListing = false;
    const recovered = await createChatStream(setup.store, request);
    expect((await events(recovered))[0]).toMatchObject({ kind: 'step', step: { message: 'Working on your request' } });
    expect(setup.model.requests[1].body.tools.map(tool => tool.function.name)).toContain('notes__read_note');
    await vi.waitFor(() => expect(remote.boundary.streams.size).toBe(0));
    expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
  });

  it('continues after native source retrieval fails on corrupt disk state and restores research selection after repair', async () => {
    const setup = await fixture();
    const warning = vi.spyOn(console, 'warn');
    const manifest = path.join(setup.root, 'workspaces.json');
    const original = await readFile(manifest);
    const remote = await notebook(setup.root);
    remote.boundary.holdListing = true;
    await setup.store.updateSettings({ mcpServers: [remote.config] });
    const request = { canvasId: setup.canvas.id, messages: [{ role: 'user', content: 'Build a temporary research canvas roadmap for the launch checklist.' }] };
    const pending = createChatStream(setup.store, request);
    await remote.entered.promise;
    await writeFile(manifest, '{broken workspace manifest');
    remote.release.resolve();
    const fallback = await pending;
    expect(warning).toHaveBeenCalledWith('Local chat source retrieval unavailable; continuing with document tools.', 'SyntaxError');
    await writeFile(manifest, original);
    const result = await events(fallback);
    expect(result.some(event => event.kind === 'answer_canvas')).toBe(false);
    expect(result.some(event => event.kind === 'research_patch')).toBe(true);
    expect(result.filter(event => event.kind === 'text').map(event => event.content).join('')).toBe('The release requires QA approval.');
    expect(setup.model.requests[0].body.tools.map(tool => tool.function.name)).toContain('draw_research_canvas');
    const recovered = await createChatStream(new CanvasStore(setup.root), request);
    const recoveredEvents = await events(recovered);
    expect(recoveredEvents[0]).toMatchObject({ kind: 'answer_canvas', canvas: { surface: 'canvas', selection: 'local',
      sources: expect.arrayContaining([expect.objectContaining({ blockId: 'launch-checklist' })]) } });
    expect(recoveredEvents.some(event => event.kind === 'research_patch')).toBe(true);
    expect(setup.model.requests[1].body.tools.map(tool => tool.function.name)).toContain('draw_research_canvas');
    expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
  });

  it('closes native MCP discovery that rejects after preparation cancellation without starting the model', async () => {
    const setup = await fixture();
    const remote = await notebook(setup.root);
    remote.boundary.holdListing = true;
    await setup.store.updateSettings({ mcpServers: [remote.config] });
    const stop = new AbortController();
    const reason = new Error('User stopped MCP preparation');
    const request = { canvasId: setup.canvas.id, messages: [{ role: 'user', content: 'Review the release.' }] };
    const pending = createChatStream(setup.store, request, undefined, { signal: stop.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await remote.entered.promise;
    stop.abort(reason);
    await rejected;
    await vi.waitFor(() => expect(remote.boundary.streams.size).toBe(0));
    expect(remote.boundary.closedStreams).toBeGreaterThan(0);
    expect(setup.model.requests).toEqual([]);
    expect(remote.boundary.calls).toEqual([]);
    remote.release.resolve();
    remote.boundary.holdListing = false;
    const recovered = await createChatStream(new CanvasStore(setup.root), request);
    expect((await tokens(recovered)).join('')).toBe('The release requires QA approval.');
    expect(setup.model.requests[0].body.tools.map(tool => tool.function.name)).toContain('notes__read_note');
  });

  it('honors an already canceled public preparation request and recovers using the same saved provider settings', async () => {
    const setup = await fixture();
    const body = { canvasId: setup.canvas.id, messages: [{ role: 'user', content: 'Review the release.' }] };
    const request = await requestContext(setup.store, body);
    const config = await agentConfiguration(setup.store);
    const stop = new AbortController();
    const reason = new Error('Preparation was canceled before entry');
    stop.abort(reason);
    await expect(preparedChatStream(setup.store, request, config, chatAgent, stop.signal)).rejects.toBe(reason);
    expect(setup.model.requests).toEqual([]);
    const recovered = await preparedChatStream(setup.store, request, config, chatAgent);
    expect((await tokens(recovered)).join('')).toBe('The release requires QA approval.');
    expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
  });

  it.each([new Error('Stopped while reading saved sources'), 'User canceled source reading'])(
    'closes an acquired native MCP connection when source-file reading is canceled with %s, then recovers', async reason => {
      const setup = await fixture();
      const remote = await notebook(setup.root);
      remote.boundary.holdListing = true;
      await setup.store.updateSettings({ mcpServers: [remote.config] });
      const manifest = path.join(setup.root, 'workspaces.json');
      const backup = manifest + '.before-source-reading';
      const original = await readFile(manifest);
      const stop = new AbortController();
      const body = { canvasId: setup.canvas.id, messages: [{ role: 'user', content: 'What blocks the launch?' }] };
      const pending = createChatStream(setup.store, body, undefined, { signal: stop.signal });
      const rejected = expect(pending).rejects.toBe(reason);
      await remote.entered.promise;
      const warning = vi.spyOn(console, 'warn');
      await rename(manifest, backup);
      let writer: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await promisify(execFile)('mkfifo', [manifest]);
        remote.release.resolve();
        // A native FIFO writer opens only after the source reader has opened the
        // other end. This holds real filesystem I/O without replacing app methods.
        writer = await open(manifest, 'w');
        stop.abort(reason);
        await rejected;
        await vi.waitFor(() => expect(remote.boundary.streams.size).toBe(0));
        expect(remote.boundary.closedStreams).toBeGreaterThan(0);
        expect(remote.boundary.calls).toEqual([]);
        expect(setup.model.requests).toEqual([]);
        expect(warning).not.toHaveBeenCalled();
      } finally {
        stop.abort(reason);
        remote.release.resolve();
        if (writer) { await writer.writeFile(original); await writer.close(); }
        await rm(manifest, { force: true });
        await rename(backup, manifest);
        warning.mockRestore();
      }
      remote.boundary.holdListing = false;
      const recovered = await createChatStream(new CanvasStore(setup.root), body);
      const output = await events(recovered);
      expect(output.some(event => event.kind === 'answer_canvas' && event.canvas.selection === 'local')).toBe(true);
      expect(output.filter(event => event.kind === 'text').map(event => event.content).join('')).toBe('The release requires QA approval.');
      expect(setup.model.requests[0].body.tools.map(tool => tool.function.name)).toContain('notes__read_note');
      expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
    });
});
