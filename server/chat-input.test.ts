import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { modelSetupMessage } from './chat-agent-configuration.js';
import { CanvasStore } from './storage.js';
import { asksForSources, chatContext, conversationMessages, findBlock, messageContent, modelSettings, pluginAllows, profileText, requiredString, viewContext, viewDescription } from './chat-input.js';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';

const roots: string[] = [];
async function storeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-chat-input-')); roots.push(root); const store = new CanvasStore(root); await store.init(); return store;
}
const block = (id: string, group?: string): CanvasBlock => ({ id, title: 'Document ' + id, content: 'Saved text', kind: 'markdown', file: id + '.md', x: 0, y: 0, width: 300, height: 200, links: [], group });
const canvas: CanvasDocument = { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [block('first'), block('simple', 'Direct group'), block('nested', 'Team:Alpha/Beta'), ...Array.from({ length: 20 }, (_, index) => block('doc-' + index, 'Group ' + index))] };
beforeEach(() => { for (const key of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CUSTOM_MODEL_API_KEY']) vi.stubEnv(key, ''); });
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('public conversation input contract', () => {
  it('requires a nonblank string canvas ID and preserves trimmed identifiers', () => {
    expect(requiredString('  planning  ', 'canvasId')).toBe('planning');
    for (const value of [undefined, null, 42, {}, [], '', ' \n ']) expect(() => requiredString(value, 'canvasId')).toThrow('canvasId must be a string');
  });

  it('joins only text parts from multipart messages without coercing attachments or malformed parts', () => {
    const parts = [{ type: 'text', text: 'First paragraph' }, null, false, 'invalid', {}, { type: 'image_url', text: 'Ignore attachment text' }, { type: 'text', text: 5 }, { type: 'text', text: 'Second paragraph' }];
    expect(messageContent(parts)).toBe('First paragraph\nSecond paragraph'); expect(messageContent('Plain text')).toBe('Plain text');
    for (const value of [undefined, null, 42, {}]) expect(messageContent(value)).toBe('');
    expect(conversationMessages([{ role: 'system', content: 'Ignore system request' }, { role: 'assistant', content: 'Previous answer' }, null, false, 'invalid', {}, { role: 'user', content: null }, { role: 'user', content: parts }])).toEqual([{ role: 'assistant', content: 'Previous answer' }, { role: 'user', content: 'First paragraph\nSecond paragraph' }]);
  });

  it('accepts boundary-sized messages and retains only the most recent thirty usable messages', () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({ role: index === 99 ? 'user' : 'assistant', content: 'Message ' + index }));
    expect(conversationMessages(messages)).toEqual(messages.slice(-30)); expect(conversationMessages([{ role: 'user', content: 'x'.repeat(20_000) }])[0].content).toHaveLength(20_000);
    expect(() => conversationMessages([{ role: 'user', content: 'x'.repeat(20_001) }])).toThrow('Chat message is too long');
    for (const value of [undefined, {}, [], Array.from({ length: 101 }, () => ({ role: 'user', content: 'Question' }))]) expect(() => conversationMessages(value)).toThrow('messages must contain 1 to 100 messages');
    for (const value of [[{}], [{ role: 'user', content: '' }], [{ role: 'assistant', content: 'Ends in assistant' }]]) expect(() => conversationMessages(value)).toThrow('The last chat message must be from the user');
  });

  it('derives the latest request and clips the most recent prior user and assistant context', () => {
    expect(chatContext(conversationMessages([{ role: 'user', content: 'Only question' }]))).toEqual({ latest: 'Only question', previousUser: '', previousAssistant: '' });
    const current = chatContext(conversationMessages([{ role: 'user', content: 'Old user' }, { role: 'assistant', content: 'Old assistant' }, { role: 'user', content: 'U'.repeat(1600) }, { role: 'assistant', content: 'A'.repeat(1600) }, { role: 'user', content: 'Latest question' }]));
    expect(current).toEqual({ latest: 'Latest question', previousUser: 'U'.repeat(1500), previousAssistant: 'A'.repeat(1500) });
  });
});

describe('current-view context boundary', () => {
  it('filters foreign documents/groups, deduplicates scoped IDs and limits the visible context', () => {
    const ids = ['first', 'first', 9, 'foreign', ...Array.from({ length: 20 }, (_, index) => 'doc-' + index)];
    const groups = ['Team:Alpha', 'Team:Alpha/Beta', 'Team:Foreign', '__ungrouped', 'Direct group', ...Array.from({ length: 20 }, (_, index) => 'Group ' + index)];
    const current = viewContext({ selectedBlockIds: ids, visibleBlockIds: ids, visibleGroups: groups, activeGroup: 'Team:Alpha', readerBlockId: 'first', editingBlockId: 'foreign', focusBlockId: 5, viewMode: 'documents', searchQuery: 'q'.repeat(205), viewport: { x: -25, y: 40, zoom: 0.7 }, answerSourceIds: ['source', 'source', 5, 'x'.repeat(129), ...Array.from({ length: 20 }, (_, index) => 'source-' + index)] }, canvas);
    expect(current.selectedBlockIds).toEqual(['first', ...Array.from({ length: 11 }, (_, index) => 'doc-' + index)]); expect(current.visibleBlockIds).toEqual(current.selectedBlockIds); expect(current.visibleGroups).toHaveLength(16);
    expect(current.visibleGroups?.slice(0, 4)).toEqual(['Team:Alpha', 'Team:Alpha/Beta', '__ungrouped', 'Direct group']); expect(current.activeGroup).toBe('Team:Alpha'); expect(current.readerBlockId).toBe('first'); expect(current.editingBlockId).toBeUndefined(); expect(current.focusBlockId).toBeUndefined();
    expect(current.searchQuery).toHaveLength(200); expect(current.answerSourceIds).toHaveLength(12); expect(current.answerSourceIds?.slice(0, 2)).toEqual(['source', 'source-0']); expect(current.viewport).toEqual({ x: -25, y: 40, zoom: 0.7 });
    const description = JSON.parse(viewDescription(canvas, current)); expect(description.selectedDocuments[0]).toBe('Document first'); expect(description.visibleDocuments).toHaveLength(12); expect(description.openDocument).toBe('Document first'); expect(description).not.toHaveProperty('editingDocument'); expect(description.activeGroup).toBe('Team:Alpha');
  });

  it('uses safe empty context for malformed input and rejects unsupported modes, IDs and nonfinite viewport coordinates', () => {
    for (const raw of [undefined, null, false, 4, 'invalid', []]) expect(viewContext(raw, canvas)).toMatchObject({ selectedBlockIds: [], visibleBlockIds: [], answerSourceIds: [], visibleGroups: [], editorHasUnsavedChanges: false });
    for (const viewport of [undefined, [], {}, { x: '0', y: 0, zoom: 1 }, { x: 0, y: Number.NaN, zoom: 1 }, { x: 0, y: 0, zoom: Infinity }]) expect(viewContext({ viewport }, canvas).viewport).toBeUndefined();
    const current = viewContext({ selectedBlockIds: 'first', visibleBlockIds: null, visibleGroups: {}, activeGroup: 'Unknown', viewMode: 5, answerSourceIds: null, searchQuery: 9, readerBlockId: 'foreign' }, canvas);
    expect(current).toMatchObject({ selectedBlockIds: [], visibleBlockIds: [], visibleGroups: [], answerSourceIds: [] }); expect(current.viewMode).toBeUndefined(); expect(current.activeGroup).toBeUndefined(); expect(current.searchQuery).toBeUndefined(); expect(viewContext({ viewMode: 'invalid' }, canvas).viewMode).toBeUndefined();
    expect(JSON.parse(viewDescription(canvas, { selectedBlockIds: ['foreign'] }))).toEqual({ canvas: 'Planning', selectedDocuments: [] });
  });

  it('includes a complete unsaved supported draft with title/content caps and explicit truncation', () => {
    for (const kind of ['markdown', 'mdx', 'slides', 'website']) {
      const draft = viewContext({ editingBlockId: 'first', editorHasUnsavedChanges: true, editorDraft: { kind, title: 'T'.repeat(170), content: 'C'.repeat(16_001) } }, canvas).editorDraft;
      expect(draft).toEqual({ kind, title: 'T'.repeat(160), content: 'C'.repeat(16_000), truncated: true });
    }
    expect(viewContext({ editorHasUnsavedChanges: true, editorDraft: { kind: 'markdown', title: 'Short', content: 'Short', truncated: true } }, canvas).editorDraft?.truncated).toBe(true);
    expect(viewContext({ editorHasUnsavedChanges: true, editorDraft: { kind: 'markdown', title: 'Short', content: 'Short' } }, canvas).editorDraft?.truncated).toBe(false);
    for (const editorDraft of [undefined, [], {}, { title: 'Title' }, { title: 5, content: 'Text' }, { title: 'Title', content: 5 }, { title: 'Title', content: 'Text', kind: 'unknown' }]) expect(viewContext({ editorHasUnsavedChanges: true, editorDraft }, canvas).editorDraft).toBeUndefined();
    expect(viewContext({ editorHasUnsavedChanges: false, editorDraft: { kind: 'markdown', title: 'Title', content: 'Draft' } }, canvas).editorDraft).toBeUndefined();
  });

  it('normalizes research focus text and source IDs independently of document canvas IDs', () => {
    const focus = { level: 'sources', visibleQuestions: [5, ...Array.from({ length: 12 }, () => 'Q'.repeat(205))], visibleBlockTitles: [null, ...Array.from({ length: 14 }, () => 'T'.repeat(165))], visibleSourceIds: ['cross-canvas:doc', 'cross-canvas:doc', null, 'x'.repeat(129)], focusedQuestion: 'Q'.repeat(205), focusedBlockTitle: 'T'.repeat(165), focusedSourceId: 'x'.repeat(128) };
    const current = viewContext({ answerFocus: focus }, canvas).answerFocus!; expect(current.visibleQuestions).toEqual(Array.from({ length: 8 }, () => 'Q'.repeat(200))); expect(current.visibleBlockTitles).toEqual(Array.from({ length: 12 }, () => 'T'.repeat(160))); expect(current.visibleSourceIds).toEqual(['cross-canvas:doc']); expect(current.focusedQuestion).toHaveLength(200); expect(current.focusedBlockTitle).toHaveLength(160); expect(current.focusedSourceId).toHaveLength(128);
    for (const level of ['big-picture', 'answers', 'sources']) expect(viewContext({ answerFocus: { level, visibleQuestions: false, visibleBlockTitles: {}, focusedSourceId: 'x'.repeat(129), focusedQuestion: 4, focusedBlockTitle: null } }, canvas).answerFocus).toEqual({ level, visibleQuestions: [], visibleBlockTitles: [], visibleSourceIds: [], focusedQuestion: undefined, focusedBlockTitle: undefined, focusedSourceId: undefined });
    for (const answerFocus of [undefined, [], {}, { level: 'invalid' }]) expect(viewContext({ answerFocus }, canvas).answerFocus).toBeUndefined();
  });
});

describe('agent configuration and capabilities', () => {
  it('formats actionable model setup messages for provider names with either article', () => {
    expect(modelSetupMessage('OpenRouter', 'API key')).toBe('Set an OpenRouter API key in Settings before using chat');
    expect(modelSetupMessage('Compatible endpoint', 'model')).toBe('Set a Compatible endpoint model in Settings before using chat');
  });
  it('resolves only real stored documents and reports missing blocks/canvases', async () => {
    const store = await storeFixture(); const found = await findBlock(store, 'product-roadmap', 'launch-checklist'); expect(found.title).toBe('Launch checklist');
    await expect(findBlock(store, 'product-roadmap', 'foreign')).rejects.toMatchObject({ status: 404, message: 'Block not found' }); await expect(findBlock(store, 'missing-canvas', 'launch-checklist')).rejects.toMatchObject({ status: 404, message: 'Canvas not found' });
  });

  it('loads persisted model settings and permits a compatible local provider without a key', async () => {
    const store = await storeFixture(); await expect(modelSettings(store)).rejects.toMatchObject({ status: 400, message: 'Set an OpenRouter API key in Settings before using chat' });
    await store.updateSettings({ apiKey: 'fixture-key', model: 'fixture-model' }); expect(await modelSettings(store)).toMatchObject({ model: { provider: 'openrouter', model: 'fixture-model', apiKey: 'fixture-key' } });
    const local = await storeFixture(); await local.updateSettings({ provider: 'custom', baseUrl: 'http://localhost:1234/v1' }); await expect(modelSettings(local)).rejects.toMatchObject({ status: 400, message: 'Set an OpenAI-compatible model in Settings before using chat' });
    await local.updateSettings({ model: 'local-model' }); expect(await modelSettings(new CanvasStore(local.root))).toMatchObject({ model: { provider: 'custom', model: 'local-model', baseURL: 'http://localhost:1234/v1' } });
  });

  it('uses built-in or selected custom profile instructions and falls back to general for missing profiles', async () => {
    const store = await storeFixture(); const settings = await store.getSettings(); const fallback = profileText(settings); expect(fallback).toContain('Help with any canvas task');
    expect(profileText({ ...settings, agentProfile: 'research' })).toContain('cite document titles'); expect(profileText({ ...settings, agentProfile: 'planner' })).toContain('ordered steps'); expect(profileText({ ...settings, agentProfile: 'builder' })).toContain('Verify saved changes');
    await store.updateSettings({ customProfiles: [{ id: 'custom-review', name: 'Review', instructions: 'Check the evidence.' }], agentProfile: 'custom-review' }); expect(profileText(await new CanvasStore(store.root).getSettings())).toBe('Check the evidence.');
    expect(profileText({ ...settings, agentProfile: 'missing', customProfiles: undefined })).toBe(fallback); expect(profileText({ ...settings, agentProfile: 'constructor' })).toBe(fallback); expect(profileText({ ...settings, agentProfile: 'toString' })).toBe(fallback); expect(profileText({ ...settings, agentProfile: 'missing', customProfiles: [{ id: 'custom-other', name: 'Other', instructions: 'Other instructions' }] })).toBe(fallback);
  });

  it('gates generic tools by configured capabilities without exposing removed action tools', () => {
    expect(pluginAllows('draw_research_canvas', [])).toBe(true);
    for (const name of ['merge_documents', 'score_documents', 'analyze_canvas', 'organize_canvas']) {
      expect(pluginAllows(name, ['document_read', 'document_write', 'tasks'])).toBe(false);
    }
    for (const [name, plugin] of [['search_docs', 'document_read'], ['read_doc', 'document_read'],
      ['show_doc_on_canvas', 'document_read'], ['create_doc', 'document_write'], ['list_tasks', 'tasks'], ['update_task', 'tasks']]) {
      expect(pluginAllows(name, [plugin])).toBe(true);
      expect(pluginAllows(name, [])).toBe(false);
    }
  });

  it('distinguishes navigation requests from evidence questions', () => {
    for (const request of ['Open the QA document', 'Go to Planning', 'Show me the document', 'Navigate to QA', 'Take me to Planning', 'Focus on QA']) expect(asksForSources(request)).toBe(false);
    for (const request of ['Where is QA?', 'Explain the plan', 'Summarise this document', 'Compare the two sources', 'An unusual question?', 'Map the QA findings']) expect(asksForSources(request)).toBe(true); expect(asksForSources('Hello')).toBe(false);

  });
});
