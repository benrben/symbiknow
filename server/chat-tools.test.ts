import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnswerSource, CanvasNavigationTarget, ResearchCanvasPatch, ChatViewContext } from '../shared/answer-canvas';
import { CanvasStore } from './storage';
import { canvasTools } from './chat-tools';
import { ChatProposalDraft, applyChatProposal } from './chat-proposals';

const directories: string[] = [];
async function fixture(options: { signal?: AbortSignal; view?: ChatViewContext } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-chat-tools-')); directories.push(root);
  const store = new CanvasStore(root); await store.init();
  const canvas = await store.getCanvas('product-roadmap');
  const draft = new ChatProposalDraft(store, canvas.id, canvas);
  const navigation: CanvasNavigationTarget[] = [];
  const selected: AnswerSource[] = [{ canvasId: canvas.id, canvasName: canvas.name, blockId: canvas.blocks[0].id, title: canvas.blocks[0].title, excerpt: '', relevance: 1 }];
  const patches: ResearchCanvasPatch[] = [];
  const tools = canvasTools(store, canvas.id, { query: 'Create a research canvas', navigationRequests: navigation,
    selectedSources: selected, researchPatches: patches, draft, currentView: options.view, signal: options.signal });
  const call = async <T>(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> => {
    const tool = tools.find(item => item.name === name); if (!tool) throw new Error('Missing tool: ' + name);
    return JSON.parse(String(await tool.invoke(args, { signal }))) as T;
  };
  return { root, store, canvas, draft, selected, navigation, patches, tools, call };
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('native Chat tool boundaries', () => {
  it('searches and reads staged or foreign documents', async () => {
    const { call, store, canvas, draft, tools } = await fixture();
    expect(tools.map(tool => tool.name)).toEqual(['search_docs', 'read_doc', 'show_doc_on_canvas',
      'show_group_on_canvas', 'draw_research_canvas', 'create_doc', 'edit_doc', 'move_block',
      'link_blocks', 'list_tasks', 'create_task', 'update_task',
      'jev_profile', 'find_by', 'related', 'memory_map', 'jev_activity', 'brain_inbox', 'jev_do']);
    expect((await call<unknown[]>('search_docs', { query: 'launch' })).length).toBeGreaterThan(0);
    const block = canvas.blocks[0]; draft.patch(block.id, { title: 'Staged title' }, 'edit');
    expect(await call('read_doc', { blockId: block.id })).toMatchObject({ title: 'Staged title' });
    const target = await store.createCanvas(canvas.workspaceId, { name: 'Other' });
    const foreign = await store.createBlock(target.id, { title: 'Foreign evidence', content: '# Foreign' });
    expect(await call('read_doc', { blockId: foreign.id, sourceCanvasId: target.id })).toMatchObject({ title: 'Foreign evidence' });
    expect((await store.getCanvas(canvas.id)).blocks[0].title).toBe(block.title);
  });

  it('shows current and foreign documents or groups without editing files and rejects unavailable targets', async () => {
    const { call, canvas, navigation, store } = await fixture(); const block = canvas.blocks[0];
    await store.updateBlock(canvas.id, block.id, { group: 'custom:research/review' });
    expect(await call('show_doc_on_canvas', { blockId: block.id })).toMatchObject({ shown: true, canvasId: canvas.id });
    expect(await call('show_doc_on_canvas', { blockId: block.id, sourceCanvasId: canvas.id })).toMatchObject({ shown: true });
    expect(await call('show_group_on_canvas', { group: 'custom:research' })).toMatchObject({ group: 'custom:research' });
    expect(await call('show_group_on_canvas', { group: 'custom:research/review', sourceCanvasId: canvas.id })).toMatchObject({ shown: true });
    expect(await call('show_group_on_canvas', { group: '__ungrouped' })).toMatchObject({ shown: true });
    expect(await call('show_group_on_canvas', { group: 'Removed' })).toMatchObject({ shown: false, reason: 'Group not found',
      availableGroups: expect.arrayContaining([{ group: 'custom:research/review', title: 'Review' }]) });
    expect(await call('show_doc_on_canvas', { blockId: 'removed' })).toMatchObject({ shown: false });
    await store.updateBlock(canvas.id, block.id, { archived: true });
    expect(await call('show_doc_on_canvas', { blockId: block.id })).toMatchObject({ shown: false });
    expect(navigation).toHaveLength(5);
  });

  it('finds a group by its visible title so a loose name does not fail the turn', async () => {
    const { call, canvas, navigation, store } = await fixture();
    await store.updateBlock(canvas.id, canvas.blocks[0].id, { group: 'custom:project_status_open_work' });
    expect(await call('show_group_on_canvas', { group: 'Project status: open work' }))
      .toMatchObject({ shown: true, group: 'custom:project_status_open_work', title: 'Project status open work' });
    expect(navigation.at(-1)).toMatchObject({ kind: 'group', group: 'custom:project_status_open_work' });
    const labelled = { ...await store.getCanvas(canvas.id), groupLabels: { 'custom:project_status_open_work': 'Project Status & Open Work' } };
    vi.spyOn(store, 'getCanvas').mockResolvedValue(labelled);
    expect(await call('show_group_on_canvas', { group: 'project status & open work' }))
      .toMatchObject({ shown: true, title: 'Project Status & Open Work' });
  });

  it('cleans research citations and edges, preserves supported loader content, and rejects duplicate block IDs', async () => {
    const { call, selected, patches } = await fixture();
    const source = `${selected[0].canvasId}:${selected[0].blockId}`;
    const blocks = [{ id: 'answer', type: 'text', title: 'Answer', kind: 'html', content: '<h1>Answer</h1>', sourceIds: [source, source, 'missing:source'] },
      { id: 'next', type: 'task', title: 'Next', content: 'Review', sourceIds: [] }];
    expect(await call('draw_research_canvas', { layout: 'roadmap', blocks, edges: [{ from: 'answer', to: 'next' }, { from: 'answer', to: 'missing' }, { from: 'missing', to: 'next' }, { from: 'answer', to: 'answer' }] })).toEqual({ drawn: true, blocks: 2, edges: 1 });
    expect(patches[0]).toMatchObject({ layout: 'roadmap', blocks: [{ id: 'answer', kind: 'markdown', sourceIds: [source] }, { id: 'next' }], edges: [{ from: 'answer', to: 'next' }] });
    await expect(call('draw_research_canvas', { blocks: [blocks[0], blocks[0]], edges: [] })).rejects.toThrow('Research block IDs must be unique');
  });

  it('stages native document edits, positions and typed links and applies the reviewed proposal with read-back', async () => {
    const { call, store, canvas, draft } = await fixture(); const first = canvas.blocks[0]; const second = canvas.blocks[1];
    const created = await call<{ id: string }>('create_doc', { title: 'Proposed HTML', content: '<h1>Proposed</h1>', kind: 'html' });
    expect((await store.getCanvas(canvas.id)).blocks.some(block => block.id === created.id)).toBe(false);
    await call('edit_doc', { blockId: first.id, title: 'Reviewed title' });
    await call('move_block', { blockId: first.id, x: 2000, y: 1500 });
    await call('link_blocks', { fromBlockId: first.id, toBlockId: second.id });
    await call('link_blocks', { fromBlockId: created.id, toBlockId: first.id, relation: 'prerequisite' });
    const receipt = await applyChatProposal(store, draft.publish()!.id);
    const saved = await store.getCanvas(canvas.id);
    expect(saved.blocks.find(block => block.id === first.id)).toMatchObject({ title: 'Reviewed title', x: 2000, y: 1500, links: expect.arrayContaining([second.id]) });
    expect(saved.blocks.find(block => block.id === receipt.createdBlockIds[created.id])).toMatchObject({ kind: 'markdown', links: [first.id], linkTypes: { [first.id]: 'prerequisite' } });
  });

  it('protects the active unsaved editor but permits edits to a different document', async () => {
    const view = { editingBlockId: 'roadmap-overview', editorHasUnsavedChanges: true } as ChatViewContext;
    const { call } = await fixture({ view });
    await expect(call('edit_doc', { blockId: 'roadmap-overview', title: 'Overwrite' })).rejects.toThrow('Save or discard your unsaved editor changes');
    expect(await call('edit_doc', { blockId: 'launch-checklist', title: 'Safe draft' })).toMatchObject({ proposed: true, title: 'Safe draft' });
  });

  it('writes tasks through native tool schemas and reads the saved board', async () => {
    const { call, store, canvas } = await fixture();
    const task = await call<{ id: string }>('create_task', { title: 'Reviewed work', blockIds: [canvas.blocks[0].id] });
    await call('update_task', { taskId: task.id, status: 'done', detail: 'Completed' });
    expect(await call('list_tasks')).toEqual(await store.listTasks(canvas.id));
    expect((await store.listTasks(canvas.id)).find(item => item.id === task.id)).toMatchObject({ title: 'Reviewed work', status: 'done', detail: 'Completed' });
  });

  it('does not mutate when the shared run or invocation has already been stopped', async () => {
    const controller = new AbortController(); controller.abort();
    const { call, store, canvas } = await fixture({ signal: controller.signal });
    await expect(call('create_task', { title: 'Stopped task' })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(call('update_task', { taskId: 'missing', title: 'Stopped update' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await store.getCanvas(canvas.id)).toEqual(canvas); expect(await store.listTasks(canvas.id)).toEqual([]);
  });
});
