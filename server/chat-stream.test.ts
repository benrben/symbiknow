import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { ApiError, CanvasStore } from './storage';
import { createApiServer } from './index';
import { createChatStream, openRouterAgent, sendChatStream, type ChatStreamSession, type DeepAgentFactory } from './chat-stream';
import type { JevDecider, JevQuestion, JevAnswer } from './jev';

const directories: string[] = [];
const servers: Server[] = [];
const nativeFetch = globalThis.fetch;

const approvedDecider: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([name, question]) => [name,
  question.type === 'choice' ? { type: 'choice', choice: 'multiple', confidence: 1,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(choice => [choice, choice === 'multiple' ? 1 : 0])) }
    : { type: 'noul', noul: 1 },
])) as Record<string, JevAnswer>;

beforeEach(() => {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://api.typesafe.ai/v1/systemone') {
      const payload = JSON.parse(String(init?.body)) as { questions: Record<string, JevQuestion> };
      return approvedDecider('test-key', '', payload.questions).then(answers => Response.json({ answers }));
    }
    return nativeFetch(input, init);
  });
});

async function storeFixture(): Promise<CanvasStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-chat-stream-'));
  directories.push(root);
  const store = new CanvasStore(root);
  await store.init();
  await store.updateSettings({ jevApiKey: 'test-jev-key' });
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
  it('merges only with a token bound to the exact document set', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    const canvas = await store.getCanvas('product-roadmap');
    const keeper = canvas.blocks.find(block => block.id === 'roadmap-overview')!;
    const merged = canvas.blocks.find(block => block.id === 'pitch-slides')!;
    const validator = vi.fn((_token: string, scope: { canvasId: string; action: string; blockIds: string[] }) =>
      scope.canvasId === canvas.id && scope.action === 'merge documents'
      && scope.blockIds.join() === `${keeper.id},${merged.id}`);
    const factory: DeepAgentFactory = (_settings, tools) => async function* (messages) {
      expect(tools.map(item => item.name)).toContain('merge_documents');
      const result = await tools.find(item => item.name === 'merge_documents')!.invoke({
        keepBlockId: keeper.id, mergeBlockIds: [merged.id], content: `${keeper.content}\n\n${merged.content}`,
        expectedContentHashes: { [keeper.id]: keeper.contentHash, [merged.id]: merged.contentHash },
      });
      expect(String(result)).toContain('archivedBlockIds');
      yield { messages: [...messages, new AIMessage('Merged the two documents.')] };
    };
    const decider: JevDecider = async (_key, _state, questions): Promise<Record<string, JevAnswer>> => {
      if ('intent' in questions) return { intent: { type: 'choice', choice: 'organize', confidence: 1, probabilities: { organize: 1 } } };
      if ('authorized' in questions) throw new Error('A valid token must skip the Jev gate');
      return { has_claims: { type: 'noul', noul: 0.1 }, supported: { type: 'noul', noul: 1 } };
    };
    const session = await createChatStream(store, { ...body, intentToken: 'merge-token', messages: [{ role: 'user', content: 'yes' }] },
      factory, decider, { validateIntentToken: validator });
    for await (const chunk of session.tokens(new AbortController().signal)) { void chunk; }
    expect(validator).toHaveBeenCalledWith('merge-token', {
      canvasId: canvas.id, action: 'merge documents', blockIds: [keeper.id, merged.id],
    });
    const after = await store.getCanvas(canvas.id);
    expect(after.blocks.some(block => block.id === merged.id)).toBe(false);
    expect(after.blocks.find(block => block.id === keeper.id)?.content).toContain(merged.content);
  });

  it('routes a confident read-only request to read tools without exposing write tools', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    let offered: string[] = [];
    const factory: DeepAgentFactory = (_settings, tools, prompt) => {
      offered = tools.map(item => item.name);
      expect(prompt).toContain('appears to be answer');
      return async function* (messages) { yield { messages: [...messages, new AIMessage('The launch is planned.')] }; };
    };
    const decider: JevDecider = async (_key, _state, questions): Promise<Record<string, JevAnswer>> => 'intent' in questions
      ? { intent: { type: 'choice', choice: 'answer', confidence: 0.95, probabilities: { answer: 0.95 } } }
      : { supported: { type: 'noul', noul: 0.98 } };
    const session = await createChatStream(store, { ...body, messages: [{ role: 'user', content: 'What is the launch status?' }] }, factory, decider);
    const chunks: string[] = [];
    for await (const chunk of session.tokens(new AbortController().signal)) chunks.push(chunk);
    expect(chunks.join('')).toBe('The launch is planned.');
    expect(offered).toEqual(['search_docs', 'read_doc', 'show_doc_on_canvas', 'show_group_on_canvas', 'analyze_canvas', 'list_tasks']);
  });

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
      factory, approvedDecider);
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
    const decider: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (id === 'intent') return [id, { type: 'choice', choice: 'answer', confidence: 1, probabilities: { answer: 1 } }];
      if (id === 'research_layout') return [id, { type: 'choice', choice: 'architecture', confidence: 1, probabilities: { architecture: 1 } }];
      if (id.startsWith('source_') && question.type === 'score') return [id, { type: 'score', score: 4, confidence: 1, probabilities: { '4': 1 } }];
      return [id, { type: 'noul', noul: 1 }];
    })) as Record<string, JevAnswer>;
    const session = await createChatStream(store, { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'What blocks launch?' }] }, factory, decider);
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
    const decider: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (id === 'intent') return [id, { type: 'choice', choice: 'answer', confidence: 1, probabilities: { answer: 1 } }];
      if (id === 'answer_surface') return [id, { type: 'choice', choice: 'chat', confidence: 1, probabilities: { chat: 1 } }];
      if (question.type === 'score') return [id, { type: 'score', score: 4, confidence: 1, probabilities: { '4': 1 } }];
      return [id, { type: 'noul', noul: 1 }];
    })) as Record<string, JevAnswer>;
    const session = await createChatStream(store, { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Which tests failed?' }] }, factory, decider);
    const events = [];
    for await (const event of session.events!(new AbortController().signal)) events.push(event);
    expect(offered).not.toContain('draw_research_canvas');
    expect(events.some(event => event.kind === 'answer_canvas' || event.kind === 'research_patch')).toBe(false);
    expect(events.some(event => event.kind === 'text' && event.content.includes('two mobile tests'))).toBe(true);
  });

  it('routes the research canvas choice to the drawing tool even when intent suggests creating a main-canvas document', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    let offered: string[] = [];
    const factory: DeepAgentFactory = (_settings, tools) => async function* (messages) {
      offered = tools.map(item => item.name);
      yield { messages: [...messages, new AIMessage('I will map the research.')] };
    };
    const decider: JevDecider = async (_key, _state, questions) => {
      const answers: Record<string, JevAnswer> = {};
      for (const [id, question] of Object.entries(questions)) answers[id] = id === 'intent'
        ? { type: 'choice', choice: 'create', confidence: 1, probabilities: { create: 1 } }
        : id === 'answer_surface'
          ? { type: 'choice', choice: 'chat', confidence: 1, probabilities: { chat: 1 } }
          : question.type === 'score'
            ? { type: 'score', score: 4, confidence: 1, probabilities: { '4': 1 } }
            : { type: 'noul', noul: 1 };
      return answers;
    };
    const session = await createChatStream(store, { canvasId: 'product-roadmap', messages: [{ role: 'user',
      content: 'Create a temporary research canvas for: launch blockers' }] }, factory, decider);
    for await (const event of session.events!(new AbortController().signal)) expect(event.kind).toBeDefined();
    expect(offered).toContain('draw_research_canvas');
  });

  it('offers current-view, research-canvas, and navigation choices for an unclear request', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    const factory: DeepAgentFactory = () => { throw new Error('The agent should wait for the user choice'); };
    const decider: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (id === 'intent') return [id, { type: 'choice', choice: 'answer', confidence: 1, probabilities: { answer: 1 } }];
      if (id === 'answer_surface') return [id, { type: 'choice', choice: 'clarify', confidence: 1, probabilities: { clarify: 1 } }];
      if (question.type === 'score') return [id, { type: 'score', score: 4, confidence: 1, probabilities: { '4': 1 } }];
      return [id, { type: 'noul', noul: 1 }];
    })) as Record<string, JevAnswer>;
    const session = await createChatStream(store, { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Help me with this?' }] }, factory, decider);
    const events = [];
    for await (const event of session.events!(new AbortController().signal)) events.push(event);
    const choice = events.find(event => event.kind === 'presentation_choice');
    expect(choice?.choice.options.map(option => option.label)).toEqual(['Build a research canvas', 'Work on this view', 'Take me to the source']);
    expect(events.some(event => event.kind === 'research_patch')).toBe(false);
  });

  it('offers create and typed linking together after an explicit gap draft approval', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    let offered: string[] = [];
    const factory: DeepAgentFactory = (_settings, tools) => {
      offered = tools.map(item => item.name);
      return async function* (messages) { yield { messages: [...messages, new AIMessage('Ready to save the draft.')] }; };
    };
    const decider: JevDecider = async (_key, _state, questions): Promise<Record<string, JevAnswer>> => 'intent' in questions
      ? { intent: { type: 'choice', choice: 'create', confidence: 0.95, probabilities: { create: 0.95 } } }
      : approvedDecider(_key, _state, questions);
    const session = await createChatStream(store, { ...body, messages: [{ role: 'user', content: 'Create the approved draft and link it as a prerequisite.' }] }, factory, decider);
    for await (const piece of session.tokens(new AbortController().signal)) { void piece; }
    expect(offered).toContain('create_doc');
    expect(offered).toContain('link_blocks');
  });

  it('offers the new read-only analysis tools and scores documents without changing them', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    const before = await store.getCanvas('product-roadmap');
    const factory: DeepAgentFactory = (_settings, tools) => async function* (messages) {
      const names = tools.map(item => item.name);
      expect(names).toEqual(['search_docs', 'read_doc', 'show_doc_on_canvas', 'show_group_on_canvas', 'analyze_canvas', 'find_duplicates', 'connect_across_canvases', 'score_documents', 'list_tasks']);
      const scores = JSON.parse(String(await tools.find(item => item.name === 'score_documents')!.invoke({}))) as Array<{ quality: { score: number } }>;
      expect(scores).toHaveLength(before.blocks.length);
      expect(scores.every(item => item.quality.score === 1)).toBe(true);
      expect(await tools.find(item => item.name === 'connect_across_canvases')!.invoke({})).toBe('[]');
      yield { messages: [...messages, new AIMessage('I checked document quality.')] };
    };
    const decider: JevDecider = async (_key, _state, questions): Promise<Record<string, JevAnswer>> => {
      if ('intent' in questions) return { intent: { type: 'choice', choice: 'analyze', confidence: 1, probabilities: { analyze: 1 } } };
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, question.type === 'score'
        ? { type: 'score', score: 4, confidence: 1, probabilities: { '4': 1 } }
        : { type: 'noul', noul: 1 }]));
    };
    const session = await createChatStream(store, { ...body, messages: [{ role: 'user', content: 'Score these documents.' }] }, factory, decider);
    for await (const chunk of session.tokens(new AbortController().signal)) { void chunk; }
    expect((await store.getCanvas('product-roadmap')).blocks.map(block => block.quality)).toEqual(before.blocks.map(block => block.quality));
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
    }, factory, approvedDecider);
    for await (const chunk of session.tokens(new AbortController().signal)) { void chunk; }
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'launch-checklist')!.content).toBe(original);
  });

  it('marks an unsupported answer and preserves normal chat when verification fails', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    const factory: DeepAgentFactory = () => async function* (messages) {
      yield { messages: [...messages, new AIMessage('The launch was canceled yesterday.')] };
    };
    const unsupported: JevDecider = async (_key, state, questions): Promise<Record<string, JevAnswer>> => {
      if ('intent' in questions) return { intent: { type: 'choice', choice: 'answer', confidence: 0.5, probabilities: { answer: 0.5 } } };
      expect(state).toMatchObject({ answer: 'The launch was canceled yesterday.', sources: expect.arrayContaining([expect.objectContaining({ title: 'Roadmap overview' })]) });
      expect(questions).toHaveProperty('claim_0');
      return { has_claims: { type: 'noul', noul: 1 }, claim_0: { type: 'noul', noul: 0.1 },
        source_0: { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } } };
    };
    const flagged = await createChatStream(store, body, factory, unsupported);
    const flaggedEvents = [];
    for await (const event of flagged.events!(new AbortController().signal)) flaggedEvents.push(event);
    expect(flaggedEvents.filter(event => event.kind === 'text').map(event => event.kind === 'text' ? event.content : '').join('')).toBe('The launch was canceled yesterday.');
    expect(flaggedEvents.slice(-2)).toMatchObject([
      { kind: 'verification', verification: { status: 'checking' } },
      { kind: 'verification', verification: { status: 'unsupported', score: 0.1,
        claims: [{ text: 'The launch was canceled yesterday.', score: 0.1, supported: false }] } },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noVerification: JevDecider = async (_key, _state, questions): Promise<Record<string, JevAnswer>> => {
      if ('intent' in questions) return { intent: { type: 'choice', choice: 'answer', confidence: 0.9, probabilities: { answer: 0.9 } } };
      throw new Error('Jev offline');
    };
    const normal = await createChatStream(store, body, factory, noVerification);
    const normalChunks: string[] = [];
    for await (const chunk of normal.tokens(new AbortController().signal)) normalChunks.push(chunk);
    expect(normalChunks.join('')).toBe('The launch was canceled yesterday.');
    expect(warn).toHaveBeenCalledWith('Jev answer verification unavailable; sending the chat answer without verification.');
    warn.mockRestore();
  });

  it('verifies with documents read this turn before similarity matches and skips claims-free badges', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    let sources: Array<{ blockId: string; content: { outline: string } }> = [];
    const factory: DeepAgentFactory = (_settings, tools) => async function* (messages) {
      await tools.find(item => item.name === 'read_doc')!.invoke({ blockId: 'pitch-slides' });
      await tools.find(item => item.name === 'search_docs')!.invoke({ query: 'Launch checklist' });
      yield { messages: [...messages, new AIMessage('The pitch deck discusses Acme Team goals.')] };
    };
    const decider: JevDecider = async (_key, state, questions): Promise<Record<string, JevAnswer>> => {
      if ('intent' in questions) return { intent: { type: 'choice', choice: 'answer', confidence: 1, probabilities: { answer: 1 } } };
      expect(questions).toHaveProperty('has_claims');
      expect(questions).toHaveProperty('claim_0');
      sources = (state as { sources: typeof sources }).sources;
      return { has_claims: { type: 'noul', noul: 1 }, claim_0: { type: 'noul', noul: 0.91 },
        source_0: { type: 'choice', choice: 's0', confidence: 1, probabilities: { s0: 1 } } };
    };
    const session = await createChatStream(store, { ...body, messages: [{ role: 'user', content: 'Summarize the pitch.' }] }, factory, decider);
    const events = [];
    for await (const event of session.events!(new AbortController().signal)) events.push(event);
    expect(sources[0].blockId).toBe('pitch-slides');
    expect(sources.some(source => source.blockId === 'launch-checklist')).toBe(true);
    expect(sources[0].content.outline).toContain('Acme Team');
    expect(sources.length).toBeLessThanOrEqual(12);
    expect(events.at(-1)).toMatchObject({ kind: 'verification', verification: { status: 'supported', score: 0.91,
      checkedClaims: 1, totalClaims: 1,
      claims: [{ supported: true, source: { blockId: 'pitch-slides', evidence: {
        claim: 'The pitch deck discusses Acme Team goals.', passageKind: 'approximation',
        navigation: { kind: 'document', blockId: 'pitch-slides' },
      } } }] } });

    const noClaims: JevDecider = async (_key, _state, questions): Promise<Record<string, JevAnswer>> => 'intent' in questions
      ? { intent: { type: 'choice', choice: 'answer', confidence: 1, probabilities: { answer: 1 } } }
      : { has_claims: { type: 'noul', noul: 0.1 }, supported: { type: 'noul', noul: 0.1 } };
    const plainFactory: DeepAgentFactory = () => async function* (messages) {
      yield { messages: [...messages, new AIMessage('Happy to help.')] };
    };
    const plain = await createChatStream(store, { ...body, messages: [{ role: 'user', content: 'Thanks' }] }, plainFactory, noClaims);
    const plainEvents = [];
    for await (const event of plain.events!(new AbortController().signal)) plainEvents.push(event);
    expect(plainEvents.at(-1)).toEqual({ kind: 'verification', verification: { status: 'no_claims' } });
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
    const decider = vi.fn(approvedDecider);
    const session = await createChatStream(store, body, factory, decider);
    const chunks: string[] = [];
    for await (const chunk of session.tokens(new AbortController().signal)) chunks.push(chunk);
    expect(chunks.join('')).toBe('I found the document.');
    expect(names).toEqual(['search_docs', 'read_doc', 'show_doc_on_canvas', 'show_group_on_canvas']);
    expect(prompt).toContain('Investigate relevant documents');
    expect(decider).not.toHaveBeenCalled();
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
      body: JSON.stringify({ apiKey: 'private-key', jevApiKey: 'test-jev-key', model: 'vendor/model' }) });
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
      body: JSON.stringify({ apiKey: 'private-openrouter-key', jevApiKey: 'private-jev-key', model: 'vendor/model' }) });
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
    expect(stream).not.toMatch(/private query|private document body|private-openrouter-key|private-jev-key/);
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
    const session = await createChatStream(store, body, factory, approvedDecider);
    const events = [];
    for await (const event of session.events!(new AbortController().signal)) events.push(event);
    expect(events.filter(event => event.kind === 'step')).toEqual([
      { kind: 'step', step: { type: 'thinking', message: 'Working on your request' } },
      { kind: 'step', step: { type: 'tool_start', id: 'tool-2', name: 'tool', message: 'Running tool' } },
      { kind: 'step', step: { type: 'tool_end', id: 'tool-2', name: 'tool', message: 'Finished tool' } },
      { kind: 'step', step: { type: 'thinking', message: 'Reviewing the tool result' } },
    ]);
    expect(events.filter(event => event.kind === 'text').at(-1)).toEqual({ kind: 'text', content: 'Done.' });
    expect(events.at(-1)).toEqual({ kind: 'verification', verification: { status: 'supported', score: 1 } });
  });

  it('streams model tokens as they arrive and resets a note written before a tool call', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'openrouter-key', model: 'vendor/model' });
    const top = { langgraph_node: 'model_request', langgraph_checkpoint_ns: 'model_request:1' };
    const nested = { langgraph_node: 'model_request', langgraph_checkpoint_ns: 'tools:1|model_request:2' };
    const factory: DeepAgentFactory = () => async function* (messages) {
      yield ['messages', [new AIMessageChunk({ content: 'Let me look. ', id: 'm1' }), top]];
      yield ['messages', [new AIMessageChunk({ content: '', id: 'm1', tool_call_chunks: [{ name: 'search_docs', args: '{}', id: 'c1', index: 0 }] }), top]];
      const call = new AIMessage({ content: 'Let me look. ', tool_calls: [{ id: 'c1', name: 'search_docs', args: {} }] });
      yield ['values', { messages: [...messages, call] }];
      const result = new ToolMessage({ content: 'private', tool_call_id: 'c1', name: 'search_docs' });
      yield ['values', { messages: [...messages, call, result] }];
      yield ['messages', [new AIMessageChunk({ content: 'Subagent text', id: 's1' }), nested]];
      yield ['messages', [new AIMessageChunk({ content: 'Found ', id: 'm2' }), top]];
      yield ['messages', [new AIMessageChunk({ content: 'it.', id: 'm2' }), top]];
      yield ['values', { messages: [...messages, call, result, new AIMessage('Found it.')] }];
    };
    const session = await createChatStream(store, body, factory, approvedDecider);
    const events = [];
    for await (const event of session.events!(new AbortController().signal)) events.push(event);
    const visible = events.filter(event => event.kind !== 'step');
    expect(visible).toEqual([
      { kind: 'text', content: 'Let me look. ' },
      { kind: 'reset' },
      { kind: 'text', content: 'Found ' },
      { kind: 'text', content: 'it.' },
      { kind: 'verification', verification: { status: 'checking' } },
      { kind: 'verification', verification: { status: 'supported', score: 1 } },
    ]);
    expect(events).toContainEqual({ kind: 'step', step: { type: 'tool_start', id: 'c1', name: 'search_docs', message: 'Running search_docs' } });
  });

  it('uses the selected provider base URL and a custom profile', async () => {
    const store = await storeFixture();
    await store.updateSettings({ provider: 'custom', baseUrl: 'http://llm.internal:11434/v1', model: 'llama3.1',
      customProfiles: [{ name: 'Sales coach', instructions: 'Coach the sales team on next steps.' }], agentProfile: 'custom-sales-coach' });
    let received: unknown;
    let prompt = '';
    const factory: DeepAgentFactory = (settings, _tools, systemPrompt) => {
      received = settings;
      prompt = systemPrompt;
      return async function* (messages) { yield { messages: [...messages, new AIMessage('Ready.')] }; };
    };
    const session = await createChatStream(store, body, factory, approvedDecider);
    for await (const chunk of session.tokens(new AbortController().signal)) void chunk;
    expect(received).toMatchObject({ provider: 'custom', baseURL: 'http://llm.internal:11434/v1', model: 'llama3.1', apiKey: 'not-needed' });
    expect(prompt).toContain('Coach the sales team on next steps.');
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
    const session = await createChatStream(store, body, snapshotFactory, approvedDecider);
    const events = [];
    for await (const event of session.events!(afterSnapshot.signal)) events.push(event);
    expect(events).toEqual([{ kind: 'step', step: { type: 'thinking', message: 'Working on your request' } }]);

    const duringFailure = new AbortController();
    const failureFactory: DeepAgentFactory = () => async function* () {
      duringFailure.abort();
      throw new Error('Private upstream details');
    };
    const failed = await createChatStream(store, body, failureFactory, approvedDecider);
    const failureEvents = [];
    for await (const event of failed.events!(duringFailure.signal)) failureEvents.push(event);
    expect(failureEvents).toEqual([]);
  });

  it('turns an agent failure into a clear JSON upstream error without exposing the key', async () => {
    const factory: DeepAgentFactory = () => async function* () { throw new Error('private-key connection details'); };
    const base = await serverFixture(factory);
    await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'private-key', model: 'vendor/model' }) });
    const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'OpenRouter request failed. Check the model and API key in Settings.' });
  });

  it.each([
    [401, 'The API key was rejected. Check it in Settings.'],
    [402, 'The account has insufficient credits. Check billing with the provider.'],
    [429, 'The provider rate limit was reached. Retry shortly.'],
  ])('shows a safe provider reason for upstream status %i', async (status, reason) => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'private-key', model: 'vendor/model' });
    const factory: DeepAgentFactory = () => async function* () {
      throw Object.assign(new Error('private-key details'), { status });
    };
    const session = await createChatStream(store, body, factory, approvedDecider);
    await expect(async () => { for await (const chunk of session.tokens(new AbortController().signal)) void chunk; })
      .rejects.toMatchObject({ status: 502, message: `OpenRouter request failed (${status}). ${reason}` });
  });

  it('validates message shapes and final Deep Agent output', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    const noOutput: DeepAgentFactory = () => async function* () { yield { messages: [new HumanMessage('Only user')] }; };
    await expect(createChatStream(store, { ...body, canvasId: '' }, noOutput)).rejects.toMatchObject({ status: 400 });
    for (const messages of [null, Array(101).fill({ role: 'user', content: 'hi' }), [null],
      [{ role: 'user', content: null }], [{ role: 'tool', content: 'result' }]]) {
      await expect(createChatStream(store, { ...body, messages }, noOutput)).rejects.toMatchObject({ status: 400 });
    }
    const session = await createChatStream(store, body, noOutput);
    await expect(async () => { for await (const piece of session.tokens(new AbortController().signal)) { void piece; } })
      .rejects.toMatchObject({ status: 502, message: 'OpenRouter returned no final answer' });
    const noText: DeepAgentFactory = () => async function* () { yield { messages: [new AIMessage('')] }; };
    const empty = await createChatStream(store, body, noText);
    await expect(async () => { for await (const piece of empty.tokens(new AbortController().signal)) { void piece; } })
      .rejects.toMatchObject({ status: 502, message: 'OpenRouter returned no text' });
    const run = openRouterAgent({ model: 'vendor/model', apiKey: 'key' }, [], 'Prompt');
    const aborted = new AbortController();
    aborted.abort();
    await expect(run([new HumanMessage('Hello')], aborted.signal)).rejects.toThrow('aborted');
  });

  it('splits long final answers into ordered SSE deltas', async () => {
    const answer = 'A'.repeat(600);
    const factory: DeepAgentFactory = () => async function* (messages) {
      yield { messages: [...messages, new AIMessage(answer)] };
    };
    const base = await serverFixture(factory);
    await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'key', model: 'vendor/model' }) });
    const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const chunks = (await response.text()).split('\n\n').filter(item => item.startsWith('data: {'))
      .map(item => JSON.parse(item.slice(6)) as { choices: Array<{ delta: { content: string } }> });
    expect(chunks.slice(0, 3).map(chunk => chunk.choices[0].delta.content).join('')).toBe(answer);
    expect(chunks).toHaveLength(4);
  });

  it('sends an error event for failures after SSE headers were sent', async () => {
    const session: ChatStreamSession = { model: 'vendor/model', async *tokens() { yield 'First part. '; throw new Error('secret details'); } };
    const server = createServer((_request, response) => { void sendChatStream(response, session); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('First part.');
    expect(text).toContain('event: error\ndata: {"message":"Chat stream stopped. Check the model settings."}');
    expect(text).not.toContain('secret details');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('data: [DONE]');
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

  it('aborts an in-flight Deep Agent before SSE headers when the client disconnects', async () => {
    let started: () => void = () => {};
    const entered = new Promise<void>(resolve => { started = resolve; });
    let observed: AbortSignal | undefined;
    const session: ChatStreamSession = { model: 'vendor/model', async *tokens(signal) {
      observed = signal;
      started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield 'Too late';
    } };
    const server = createServer((_request, response) => { void sendChatStream(response, session); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${address.port}`, { signal: controller.signal });
    await entered;
    controller.abort();
    await expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(observed?.aborted).toBe(true));
  });

  it('aborts an in-flight Deep Agent after SSE headers when the client disconnects', async () => {
    let observed: AbortSignal | undefined;
    const session: ChatStreamSession = { model: 'vendor/model', async *tokens(signal) {
      observed = signal;
      yield 'First piece';
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('Stopped after disconnect');
    } };
    const server = createServer((_request, response) => { void sendChatStream(response, session); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: controller.signal });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect(new TextDecoder().decode((await reader!.read()).value)).toContain('First piece');
    controller.abort();
    await vi.waitFor(() => expect(observed?.aborted).toBe(true));
  });

  it('asks one Jev question per claim and flags the answer when any claim is unsupported', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    const answer = 'The launch date moved to March. The beta test group grew to fifty people.';
    const factory: DeepAgentFactory = () => async function* (messages) { yield { messages: [...messages, new AIMessage(answer)] }; };
    let seenQuestions: Record<string, unknown> = {};
    const decider: JevDecider = async (_key, _state, questions): Promise<Record<string, JevAnswer>> => {
      if ('intent' in questions) return { intent: { type: 'choice', choice: 'answer', confidence: 1, probabilities: { answer: 1 } } };
      seenQuestions = questions;
      return { has_claims: { type: 'noul', noul: 1 }, claim_0: { type: 'noul', noul: 0.9 }, claim_1: { type: 'noul', noul: 0.2 },
        source_0: { type: 'choice', choice: 's0', confidence: 1, probabilities: { s0: 1 } },
        source_1: { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } } };
    };
    const session = await createChatStream(store, body, factory, decider);
    const events = [];
    for await (const event of session.events!(new AbortController().signal)) events.push(event);
    expect(Object.keys(seenQuestions).sort()).toEqual(['claim_0', 'claim_1', 'has_claims', 'source_0', 'source_1']);
    expect(events.at(-1)).toMatchObject({ kind: 'verification', verification: { status: 'unsupported', score: 0.2,
      claims: [{ supported: true }, { supported: false }] } });
  });

  it('aborts the routing signal once its deadline elapses', async () => {
    const store = await storeFixture();
    await store.updateSettings({ apiKey: 'key', model: 'vendor/model' });
    let seenSignal: AbortSignal | undefined;
    const decider: JevDecider = (_key, _state, _questions, _fetcher, options) => new Promise((_resolve, reject) => {
      seenSignal = options?.signal;
      options?.signal?.addEventListener('abort', () => reject(new Error('Jev request was cancelled')));
    });
    const factory: DeepAgentFactory = () => async function* (messages) { yield { messages: [...messages, new AIMessage('Hi.')] }; };
    // routeIntent's decider never resolves on its own, so createChatStream only proceeds once the 1.5s routing deadline aborts it.
    await createChatStream(store, body, factory, decider);
    expect(seenSignal?.aborted).toBe(true);
  }, 10_000);
});
