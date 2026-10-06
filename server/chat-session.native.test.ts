import { expectRestoredCanvas } from './tests/restoration.js';
import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createChatStream } from './chat-stream.js';
import { chatAgent } from './chat-agent.js';
import { getChatProposal, applyChatProposal, undoChatProposal, type ChatProposal } from './chat-proposals.js';
import { CanvasStore } from './storage.js';
import { answer, events, fixture, omittedModelPiece, tokens, toolCalls } from './chat-session.test.fixture.js';

describe('chat sessions with installed Deep Agents and native providers', () => {
  it('emits real tool progress, review proposal and navigation through app HTTP', async () => {
    const setup = await fixture();
    setup.model.handle = (request, response) => {
      if (request.messages.some(message => message.role === 'tool')) { answer(response); return; }
      toolCalls(response, [
        { name: 'read_doc', args: { blockId: 'launch-checklist' } },
        { name: 'edit_doc', args: { blockId: 'launch-checklist', content: '# QA approval required before release' } },
        { name: 'show_doc_on_canvas', args: { blockId: 'launch-checklist' } },
      ], 'Checking the checklist. ');
    };
    const base = await setup.app();
    const response = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: setup.canvas.id, messages: [{ role: 'user', content: 'Update and open the launch checklist.' }] }) });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"name":"read_doc","message":"Running read_doc"');
    expect(stream).toContain('"name":"edit_doc","message":"Finished edit_doc"');
    expect(stream).toContain('event: answer_reset');
    expect(stream).not.toContain('event: verification');
    expect(stream).not.toContain('event: research_verification');
    expect(stream.indexOf('event: chat_proposal')).toBeLessThan(stream.indexOf('event: canvas_navigation'));
    const match = /event: chat_proposal\ndata: ([^\n]+)/.exec(stream);
    expect(match).not.toBeNull();
    const proposal = JSON.parse(match![1]) as ChatProposal;
    expect(proposal.changes).toMatchObject([{ type: 'edit', blockId: 'launch-checklist', canApply: true }]);
    expect(getChatProposal(new CanvasStore(setup.root), proposal.id)).toEqual(proposal);
    expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
    expect(setup.model.requests).toHaveLength(2);
    expect(setup.model.requests[0]).toMatchObject({ url: '/v1/chat/completions', authorization: 'Bearer local-model-secret',
      body: { model: 'native-session', stream: true } });
    expect(setup.model.requests[1].body.messages.filter(message => message.role === 'tool')).toHaveLength(3);
    const advertised = setup.model.requests[0].body.tools.map(tool => tool.function.name);
    expect(advertised).toEqual(expect.arrayContaining(['create_doc', 'edit_doc', 'read_doc']));
    expect(advertised).not.toEqual(expect.arrayContaining(['list_tasks', 'create_task', 'update_task', 'delete_task']));
    for (const name of ['analyze_canvas', 'score_documents', 'merge_documents', 'organize_canvas']) expect(advertised).not.toContain(name);
    expect(JSON.stringify(setup.model.requests[0].body.messages)).not.toContain('Jev');
    const apply = await fetch(`${base}/api/chat/proposals/${proposal.id}/apply`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(apply.status).toBe(200);
    expect((await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).blocks.find(block => block.id === 'launch-checklist')?.content)
      .toBe('# QA approval required before release');
    expect((await fetch(`${base}/api/chat/proposals/${proposal.id}/undo`, { method: 'POST' })).status).toBe(200);
    expectRestoredCanvas(await new CanvasStore(setup.root).getCanvas(setup.canvas.id), setup.canvas);
  });

  it('collects real native tokens in 256-character pieces and persists its reviewed edit', async () => {
    const setup = await fixture();
    const finalText = 'The release requires QA approval. '.repeat(17);
    setup.model.handle = (request, response) => {
      if (request.messages.some(message => message.role === 'tool')) { answer(response, [finalText]); return; }
      toolCalls(response, [{ name: 'edit_doc', args: { blockId: 'launch-checklist', content: '# Reviewed native token change' } }]);
    };
    const session = await createChatStream(setup.store, { canvasId: setup.canvas.id,
      messages: [{ role: 'user', content: 'Update the checklist.' }] });
    expect(session.model).toBe('native-session');
    const output = await tokens(session);
    expect(output.join('')).toBe(finalText);
    expect(output.map(piece => piece.length)).toEqual([256, 256, finalText.length - 512]);
    const files = await readdir(path.join(setup.root, 'chat-proposals'));
    expect(files).toHaveLength(1);
    const proposal = getChatProposal(new CanvasStore(setup.root), files[0].replace('.json', '')) as ChatProposal;
    expect(proposal.status).toBe('pending');
    expect(await setup.store.getCanvas(setup.canvas.id)).toEqual(setup.canvas);
    await applyChatProposal(new CanvasStore(setup.root), proposal.id);
    expect((await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).blocks.find(block => block.id === 'launch-checklist')?.content)
      .toBe('# Reviewed native token change');
    await undoChatProposal(new CanvasStore(setup.root), proposal.id);
    expectRestoredCanvas(await setup.store.getCanvas(setup.canvas.id), setup.canvas);
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
});
