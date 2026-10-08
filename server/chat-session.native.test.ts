import { describe, expect, it } from 'vitest';
import { createChatStream } from './chat-stream.js';
import { chatAgent } from './chat-agent.js';
import { CanvasStore } from './storage.js';
import { answer, events, fixture, fileEditResponse, omittedModelPiece, tokens, toolCalls } from './chat-session.test.fixture.js';

describe('chat sessions with installed Deep Agents and native providers', () => {
  it('edits a downloaded file through native Deep Agents and saves through canonical MCP with read-back after reopening', async () => {
    const setup = await fixture();
    const replacement = '# QA approval required before release';
    setup.model.handle = (request, response) => fileEditResponse(request, response, replacement);
    const base = await setup.app();
    const response = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: setup.canvas.id, conversationId: 'real-file-edit',
        messages: [{ role: 'user', content: 'Update the launch checklist.' }] }) });
    expect(response.status).toBe(200);
    const stream = await response.text();
    for (const name of ['download_file', 'read_file', 'edit_file', 'upload_file', 'read_doc'])
      expect(stream).toContain(`"name":"${name}","message":"Finished ${name}"`);
    expect(stream).toContain('Saved the edited checklist.');
    expect(stream).not.toContain('event: chat_proposal');
    const saved = await new CanvasStore(setup.root).getCanvasBlock(setup.canvas.id, 'launch-checklist');
    expect(saved.content).toBe(replacement);
    const advertised = setup.model.requests[0].body.tools.map(tool => tool.function.name);
    expect(advertised).toEqual(expect.arrayContaining(['download_file', 'upload_file', 'ask_symbi', 'jev_do', 'jev_resolve']));
    expect(advertised).not.toEqual(expect.arrayContaining(['create_doc', 'edit_doc']));
    expect(setup.model.requests.at(-1)?.body.messages.filter(message => message.role === 'tool').at(-1)?.content).toContain(replacement);
  });

  it('collects native tokens after the file upload has committed', async () => {
    const setup = await fixture();
    const finalText = 'The release requires QA approval. '.repeat(17);
    setup.model.handle = (request, response) => fileEditResponse(request, response, '# Native file change', finalText);
    const session = await createChatStream(setup.store, { canvasId: setup.canvas.id,
      messages: [{ role: 'user', content: 'Update the checklist.' }] });
    const output = await tokens(session);
    expect(output.join('')).toBe(finalText);
    expect(output.map(piece => piece.length)).toEqual([256, 256, finalText.length - 512]);
    expect((await new CanvasStore(setup.root).getCanvasBlock(setup.canvas.id, 'launch-checklist')).content).toBe('# Native file change');
  });

  it('forwards warnings before native model progress', async () => {
    const setup = await fixture();
    const { session, cleanup } = await setup.sessionContext({ warnings: ['External source unavailable', 'Use local documents'] });
    const output = await events(session);
    expect(output.slice(0, 3)).toEqual([
      { kind: 'step', step: { type: 'thinking', message: 'External source unavailable' } },
      { kind: 'step', step: { type: 'thinking', message: 'Use local documents' } },
      { kind: 'step', step: { type: 'thinking', message: 'Working on your request' } },
    ]);
    expect(output.filter(event => event.kind === 'text')).toEqual([
      { kind: 'text', content: 'The release ' }, { kind: 'text', content: 'requires QA approval.' },
    ]);
    expect(output.some(event => event.kind === 'reset' || event.kind === 'proposal')).toBe(false);
    expect(cleanup.closed).toBe(1);
    await expect(cleanup.file.write('closed')).rejects.toMatchObject({ code: 'EBADF' });
    const tokenSession = await setup.sessionContext({});
    expect(await tokens(tokenSession.session)).toEqual(['The release requires QA approval.']);
    expect(tokenSession.cleanup.closed).toBe(1);
  });

  it.each(['missing-piece', 'snapshots-only'] as const)('reconciles %s from a streaming adapter over the actual installed agent', async mode => {
    const setup = await fixture();
    const prepared = await setup.sessionContext({});
    const nativeRun = chatAgent(setup.settings, [], 'Answer the release question');
    // AgentRun permits snapshots without every messages chunk. Preserve the actual final native snapshot.
    prepared.context.runAgent = async function* (messages, signal) {
      for await (const item of await nativeRun(messages, signal)) {
        if (omittedModelPiece(item, mode)) continue;
        yield item;
      }
    };
    const output = await events(prepared.session);
    const replacement = output.filter(event => event.kind === 'text' || event.kind === 'reset');
    expect(replacement).toEqual(mode === 'missing-piece' ? [
      { kind: 'text', content: 'The release ' }, { kind: 'reset' }, { kind: 'text', content: 'The release requires QA approval.' },
    ] : [{ kind: 'text', content: 'The release requires QA approval.' }]);
    expect(setup.model.requests).toHaveLength(1);
    expect(prepared.cleanup.closed).toBe(1);
  });

  it.each([null, { query: 'Review release', canvasId: 'product-roadmap', selection: 'local' as const, sources: [] }])
    ('supports an independent canvas session without selected sources (%j)', async answerCanvas => {
      const setup = await fixture();
      setup.model.handle = (_request, response) => answer(response, ['## QA evidence\nThe release requires QA approval.']);
      const prepared = await setup.sessionContext({ canvasEnabled: true, answerCanvas });
      const output = await events(prepared.session);
      expect(output.some(event => event.kind === 'answer_canvas')).toBe(false);
      const patch = output.find(event => event.kind === 'research_patch');
      expect(patch).toMatchObject({ kind: 'research_patch', patch: { query: 'Review the release.',
        blocks: [expect.objectContaining({ title: 'QA evidence', sourceIds: [] })] } });
      expect(prepared.cleanup.closed).toBe(1);
    });

  it('builds native research patches with real selected sources', async () => {
    const setup = await fixture();
    const source = setup.canvas.blocks.find(block => block.id === 'launch-checklist')!;
    const sourceId = `${setup.canvas.id}:${source.id}`;
    setup.model.handle = (request, response) => {
      if (request.messages.some(message => message.role === 'tool')) { answer(response, ['The evidence is on the canvas.']); return; }
      toolCalls(response, [
        { name: 'read_doc', args: { blockId: source.id } },
        { name: 'draw_research_canvas', args: { layout: 'roadmap', blocks: [{ id: 'qa', type: 'text', title: 'QA evidence',
          content: 'The release requires QA approval.', sourceIds: [sourceId] }], edges: [] } },
        { name: 'draw_research_canvas', args: { layout: 'roadmap', blocks: [{ id: 'owner', type: 'text', title: 'Review owner',
          content: 'The launch checklist records the release review owner.', sourceIds: [sourceId] }], edges: [] } },
      ]);
    };
    const session = await createChatStream(setup.store, { canvasId: setup.canvas.id,
      messages: [{ role: 'user', content: 'Build a temporary research canvas roadmap for the launch checklist.' }] });
    const output = await events(session);
    expect(output[0]).toMatchObject({ kind: 'answer_canvas', canvas: { surface: 'canvas', selection: 'local',
      sources: expect.arrayContaining([expect.objectContaining({ blockId: source.id })]) } });
    const patches = output.filter(event => event.kind === 'research_patch');
    expect(patches).toHaveLength(2);
    expect(patches.map(event => event.patch.blocks[0].id)).toEqual(['qa', 'owner']);
    expect(output.some(event => String(event.kind).includes('verification'))).toBe(false);
    expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
  });

  it('streams exact citations from actual MCP reads when prepared retrieval supplied no sources', async () => {
    const setup = await fixture();
    const remote = await setup.store.createCanvas(setup.canvas.workspaceId, { name: 'Launch evidence sources' });
    const source = await setup.store.createBlock(remote.id, { title: 'Launch evidence', content: '# Launch evidence\nQA approval is required before release.' });
    const sourceId = `${remote.id}:${source.id}`;
    setup.model.handle = (request, response) => {
      if (request.messages.some(message => message.role === 'tool')) { answer(response, ['The source is on the research canvas.']); return; }
      toolCalls(response, [
        { name: 'read_doc', args: { canvasId: remote.id, blockId: source.id } },
        { name: 'read_doc', args: { canvasId: remote.id, blockId: source.id } },
        { name: 'draw_research_canvas', args: { blocks: [{ id: 'release', type: 'text', title: 'Launch review',
          content: 'QA approval is required before release.', sourceIds: [sourceId] }], edges: [] } },
      ]);
    };
    const prepared = await setup.toolSession({ canvasEnabled: true, answerCanvas: null });
    const output = await events(prepared.session);
    const receipt = output.find(event => event.kind === 'answer_canvas');
    expect(receipt).toMatchObject({ kind: 'answer_canvas', canvas: { surface: 'canvas', sources: [{
      canvasId: remote.id, canvasName: remote.name, blockId: source.id, title: source.title, contentHash: source.contentHash,
      evidence: { passageKind: 'exact', start: 0, end: source.content.length, passage: source.content },
    }] } });
    expect(output.filter(event => event.kind === 'answer_canvas')).toHaveLength(1);
    expect(output.findIndex(event => event.kind === 'answer_canvas')).toBeLessThan(output.findIndex(event => event.kind === 'research_patch'));
    expect(output.find(event => event.kind === 'research_patch')).toMatchObject({ patch: { blocks: [{ sourceIds: [sourceId] }] } });
    expect((await new CanvasStore(setup.root).getCanvasBlock(remote.id, source.id)).content).toBe(source.content);
  });
});
