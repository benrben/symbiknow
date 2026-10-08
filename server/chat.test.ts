import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { chat } from './chat.js';
import { CanvasStore } from './storage.js';
import { applyFileProposal, getFileProposal } from './file-branch-proposals.js';
import { uploadLocalEdit } from './chat-file-tools.test.fixture.js';
import type { DeepAgentFactory } from './chat-stream.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-json-chat-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  await store.updateSettings({ apiKey: 'fixture', model: 'fixture' });
  return store;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const request = { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Update the launch checklist for review.' }] };

describe('non-streaming chat compatibility', () => {
  it('returns reviewable document proposals without immediate writes', async () => {
    const store = await fixture();
    const before = await store.getCanvas(request.canvasId);
    const factory: DeepAgentFactory = (_settings, tools, _prompt, environment) => async function* (messages, signal) {
      await uploadLocalEdit(tools, environment!.workdir, 'launch-checklist', '# Launch note', signal);
      yield { messages: [...messages, new AIMessage('Review the proposed launch note.')] };
    };
    const reply = await chat(store, request, { agentFactory: factory });
    expect(reply).toMatchObject({ message: 'Review the proposed launch note.', changed: false, proposalId: expect.any(String) });
    expect((await store.getCanvas(request.canvasId)).blocks.map(block => block.content)).toEqual(before.blocks.map(block => block.content));
    expect(await getFileProposal(store, reply.proposalId!)).toMatchObject({ changes: [{ type: 'edit' }] });
    await applyFileProposal(store, reply.proposalId!);
    expect((await store.getCanvas(request.canvasId)).blocks.find(block => block.id === 'launch-checklist')?.content).toBe('# Launch note');
  });

  it('uses canvas tools to search and read sources without changing them', async () => {
    const store = await fixture();
    const factory: DeepAgentFactory = (_settings, tools) => async function* (messages) {
      const results = await tools.find(tool => tool.name === 'search_docs')!.invoke({ query: 'checklist' });
      const document = await tools.find(tool => tool.name === 'read_doc')!.invoke({ blockId: 'launch-checklist' });
      expect(String(results)).toContain('launch-checklist');
      expect(String(document)).toContain('Launch checklist');
      yield { messages: [...messages, new AIMessage('The launch checklist is the source.')] };
    };
    expect(await chat(store, request, { agentFactory: factory })).toEqual({ message: 'The launch checklist is the source.', changed: false });
  });

  it('validates messages and reports provider failures without leaking credentials', async () => {
    const store = await fixture();
    await expect(chat(store, { ...request, messages: [] })).rejects.toMatchObject({ status: 400 });
    const factory: DeepAgentFactory = () => async function* () {
      throw Object.assign(new Error('Rejected fixture'), { status: 401 });
    };
    await expect(chat(store, request, { agentFactory: factory })).rejects.toMatchObject({ status: 502,
      message: expect.stringContaining('API key was rejected') });
  });

  it('refuses to start an already-cancelled request', async () => {
    const store = await fixture();
    const controller = new AbortController(); controller.abort();
    await expect(chat(store, request, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
