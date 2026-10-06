// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import type { AnswerCanvasTurn, AnswerSource, ResearchLayout } from '../shared/answer-canvas';
import { patchFromMarkdown } from '../shared/research-patch';
import { useAppModel } from './app-model';
import { editedResearchGraph, emptyResearchEdits, exportEditedResearchMarkdown, patchResearchBlock, researchCanvasDocument, researchEdgeKey } from './research-edits';

const nativeFetch = globalThis.fetch;
const opened: Array<{ server: Server; root: string }> = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-research-export-'));
  const store = new CanvasStore(root); await store.init();
  const canvas = await store.getCanvas('product-roadmap');
  const block = canvas.blocks[0];
  const source: AnswerSource = { canvasId: canvas.id, canvasName: canvas.name, blockId: block.id,
    title: block.title, excerpt: block.content.slice(0, 120), relevance: 1, contentHash: block.contentHash };
  const server = await createApiServer({ dataDir: root }); opened.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native port');
  const base = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal('fetch', (route: string, init?: RequestInit) => nativeFetch(base + route, init));
  const hook = renderHook(useAppModel);
  await waitFor(() => expect(hook.result.current.canvas?.id).toBe(canvas.id));
  return { ...hook, root, canvas, source };
}

async function saveAndReload(current: Awaited<ReturnType<typeof fixture>>, layout: ResearchLayout) {
  const exported = exportEditedResearchMarkdown(current.result.current.answerTurns, layout, current.result.current.researchState.edits);
  let saved!: { id: string; name: string };
  await act(async () => { saved = await current.result.current.saveResearchCanvas(layout); });
  const fresh = new CanvasStore(current.root); await fresh.init();
  const document = await fresh.getCanvas(saved.id, true);
  expect(await fresh.getCanvas(current.canvas.id, true)).toEqual(current.canvas);
  current.unmount();
  const reloaded = renderHook(useAppModel);
  await waitFor(() => expect(reloaded.result.current.canvas?.id).toBe(current.canvas.id));
  expect(exportEditedResearchMarkdown(reloaded.result.current.answerTurns, layout, reloaded.result.current.researchState.edits)).toBe(exported);
  return { document, exported };
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/?canvas=product-roadmap'); });
afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('research export contracts through native App, HTTP, disk and restart', () => {
  it('exports edited connections in authored order and persists matching links and evidence', async () => {
    const current = await fixture();
    const turn: AnswerCanvasTurn = { id: 1, query: 'Reviewed launch evidence', answer: '', status: 'complete', sources: [current.source], patch: {
      query: 'Reviewed launch evidence', blocks: [
        { id: 'start', type: 'section', title: 'Start', content: 'Retained evidence.', sourceIds: [`${current.source.canvasId}:${current.source.blockId}`] },
        { id: 'next', type: 'text', title: 'Next', content: 'Follow-up.', sourceIds: [] },
        { id: 'removed', type: 'text', title: 'Removed', content: 'Discard this.', sourceIds: [] },
      ], edges: [{ from: 'start', to: 'next', label: 'supports' }] } };
    const edits = emptyResearchEdits();
    const initial = editedResearchGraph([turn], 'roadmap', edits);
    edits.added = [{ ...initial.blocks[0], id: 'manual', title: 'Human note', content: 'Keep the human review.', sources: [] }];
    edits.changed['1:start'] = { title: 'Reviewed start', tags: ['reviewed'], group: 'lane:plan', width: 520, height: 380 };
    edits.deleted = ['1:removed'];
    edits.addedEdges = [{ source: '1:next', target: 'manual', label: 'leads to' },
      { source: 'manual', target: 'missing', label: 'unavailable' },
      { source: '1:removed', target: 'manual', label: 'deleted' },
      { source: '1:start', target: '1:next', label: 'reviewed support' }];
    act(() => current.result.current.restoreResearchSnapshot({ turns: [turn], edits, layout: 'roadmap' }));
    const { document, exported } = await saveAndReload(current, 'roadmap');
    expect(exported).toMatch(/^# Research canvas: Reviewed launch evidence\n\nLayout: roadmap\n/u);
    expect(exported).toContain('## Connections\n- Reviewed start → Next (reviewed support)\n- Next → Human note (leads to)\n');
    expect(exported).not.toContain('Discard this.');
    expect(exported).not.toContain('(unavailable)');
    const start = document.blocks.find(block => block.title === 'Reviewed start')!;
    const next = document.blocks.find(block => block.title === 'Next')!;
    const human = document.blocks.find(block => block.title === 'Human note')!;
    expect(start).toMatchObject({ width: 520, height: 380, tags: ['reviewed'], links: [next.id],
      crossLinks: [{ canvasId: current.source.canvasId, blockId: current.source.blockId, relation: 'related' }] });
    expect(next.links).toEqual([human.id]);
    expect(human.content).toContain('Keep the human review.');
  });

  it('preserves empty authored titles rather than substituting identifiers', async () => {
    const current = await fixture();
    const turn: AnswerCanvasTurn = { id: 2, query: '', answer: '', sources: [], status: 'complete', patch: {
      query: '', blocks: [
        { id: 'a', type: 'text', title: '', content: 'First body.', sourceIds: [] },
        { id: 'b', type: 'text', title: '', content: 'Second body.', sourceIds: [] },
      ], edges: [{ from: 'a', to: 'b', label: 'related' }] } };
    act(() => current.result.current.restoreResearchSnapshot({ turns: [turn], edits: emptyResearchEdits(), layout: 'mindmap' }));
    const exported = exportEditedResearchMarkdown(current.result.current.answerTurns, 'mindmap', current.result.current.researchState.edits);
    expect(exported).toMatch(/^# Research canvas: \n\nLayout: mindmap\n/u);
    expect(exported).toContain('## Connections\n-  →  (related)\n');
    await expect(current.result.current.saveResearchCanvas('mindmap')).rejects.toThrow('title must be a nonempty string');
    const fresh = new CanvasStore(current.root); await fresh.init();
    expect(await fresh.getCanvas(current.canvas.id, true)).toEqual(current.canvas);
    const workspaces = await fresh.listWorkspaces();
    expect(workspaces.flatMap(workspace => workspace.canvases).some(canvas => canvas.name === 'Research — ')).toBe(false);
  });

  it('removes deleted connections from both export and persisted research while retaining block bodies', async () => {
    const current = await fixture();
    const turn: AnswerCanvasTurn = { id: 3, query: 'Disconnected review', answer: '', sources: [], status: 'complete', patch: {
      query: 'Disconnected review', blocks: [
        { id: 'a', type: 'text', title: 'First', content: 'First body.', sourceIds: [] },
        { id: 'b', type: 'text', title: 'Second', content: 'Second body.', sourceIds: [] },
      ], edges: [{ from: 'a', to: 'b', label: 'related' }] } };
    const initial = emptyResearchEdits();
    const next = patchResearchBlock(initial, editedResearchGraph([turn], 'architecture', initial), '3:a', { links: [] });
    expect(next.deletedEdges).toEqual([researchEdgeKey({ source: '3:a', target: '3:b', label: 'related' })]);
    act(() => current.result.current.restoreResearchSnapshot({ turns: [turn], edits: next, layout: 'architecture' }));
    const { document, exported } = await saveAndReload(current, 'architecture');
    expect(exported).not.toContain('## Connections');
    expect(exported).toContain('First body.'); expect(exported).toContain('Second body.');
    expect(document.blocks.map(block => block.links)).toEqual([[], []]);
  });

  it('exports an empty restored session with the public Untitled default and refuses an empty save', async () => {
    const current = await fixture();
    act(() => current.result.current.restoreResearchSnapshot());
    const { answerTurns, researchLayout, researchState } = current.result.current;
    expect(exportEditedResearchMarkdown(answerTurns, researchLayout, researchState.edits)).toBe('# Research canvas: Untitled\n\nLayout: mindmap\n\n');
    expect(researchCanvasDocument(answerTurns, researchLayout, researchState.edits)).toMatchObject({ name: 'Research · Untitled', blocks: [] });
    await expect(current.result.current.saveResearchCanvas('mindmap')).rejects.toThrow('Open a workspace and ask a research question first.');
    const fresh = new CanvasStore(current.root); await fresh.init();
    expect(await fresh.getCanvas(current.canvas.id, true)).toEqual(current.canvas);
  });

  it.each([{ width: 640 }, { height: 480 }])('saves an isolated card dimension %j without requiring links', async dimension => {
    const current = await fixture();
    const turn: AnswerCanvasTurn = { id: 4, query: 'Manual dimensions', answer: '# Review\nKeep the resized note.', sources: [], status: 'complete' };
    const edits = emptyResearchEdits();
    const graph = editedResearchGraph([turn], 'mindmap', edits);
    edits.changed[graph.blocks[0].id] = dimension;
    act(() => current.result.current.restoreResearchSnapshot({ turns: [turn], edits, layout: 'mindmap' }));
    const { document, exported } = await saveAndReload(current, 'mindmap');
    expect(document.blocks[0]).toMatchObject({ ...dimension, links: [], content: expect.stringContaining('Keep the resized note.') });
    expect(exported).not.toContain('## Connections');
  });

  it('removes an incomplete canvas after rejected dimensions and saves a corrected retry', async () => {
    const current = await fixture();
    const turn: AnswerCanvasTurn = { id: 5, query: 'Corrected dimensions', answer: '# Review\nKeep the complete review.', sources: [], status: 'complete' };
    const edits = emptyResearchEdits();
    const graph = editedResearchGraph([turn], 'roadmap', edits);
    edits.changed[graph.blocks[0].id] = { width: -20 };
    act(() => current.result.current.restoreResearchSnapshot({ turns: [turn], edits, layout: 'roadmap' }));
    await expect(current.result.current.saveResearchCanvas('roadmap')).rejects.toThrow('width must be');
    const fresh = new CanvasStore(current.root); await fresh.init();
    expect((await fresh.listWorkspaces()).flatMap(workspace => workspace.canvases).some(canvas => canvas.name === 'Research — Corrected dimensions')).toBe(false);
    expect(await fresh.getCanvas(current.canvas.id, true)).toEqual(current.canvas);
    act(() => current.result.current.changeResearchEdits({ ...edits, changed: { [graph.blocks[0].id]: { width: 640, height: 460 } } }));
    const { document } = await saveAndReload(current, 'roadmap');
    expect(document.blocks[0]).toMatchObject({ width: 640, height: 460, content: expect.stringContaining('Keep the complete review.') });
  });

  it('replaces manual links and restores a previously removed connection before saving', async () => {
    const current = await fixture();
    const turn: AnswerCanvasTurn = { id: 6, query: 'Reviewed connections', answer: '', sources: [], status: 'complete', patch: {
      query: 'Reviewed connections', blocks: [
        { id: 'a', type: 'text', title: 'First', content: 'First body.', sourceIds: [] },
        { id: 'b', type: 'text', title: 'Second', content: 'Second body.', sourceIds: [] },
      ], edges: [{ from: 'a', to: 'b', label: 'authored' }] } };
    const initial = emptyResearchEdits();
    initial.addedEdges = [{ source: '6:a', target: '6:b', label: 'manual' }, { source: '6:b', target: '6:a', label: 'reverse' }];
    const removed = patchResearchBlock(initial, editedResearchGraph([turn], 'mindmap', initial), '6:a', { links: [] });
    expect(removed.addedEdges).toEqual([{ source: '6:b', target: '6:a', label: 'reverse' }]);
    const restored = patchResearchBlock(removed, editedResearchGraph([turn], 'mindmap', removed), '6:a', { links: ['6:a', 'missing', '6:b'] });
    expect(restored.deletedEdges).toEqual([]);
    const confirmed = patchResearchBlock(restored, editedResearchGraph([turn], 'mindmap', restored), '6:a', { links: ['6:b'] });
    expect(confirmed.addedEdges).toEqual(restored.addedEdges);
    act(() => current.result.current.restoreResearchSnapshot({ turns: [turn], edits: confirmed, layout: 'mindmap' }));
    const { document, exported } = await saveAndReload(current, 'mindmap');
    expect(exported).toContain('## Connections\n- First → Second (related)\n- Second → First (reverse)\n');
    const [first, second] = document.blocks;
    expect(first.links).toEqual([second.id]); expect(second.links).toEqual([first.id]);
  });

  it('keeps authored diagram sections and the twelve-section limit through native research save and restart', async () => {
    const current = await fixture();
    const answer = '# System\n```mermaid\ngraph LR\nA-->B\n```\n\n' + Array.from({ length: 12 }, (_, index) =>
      `## Finding ${index + 1}\nRetained finding ${index + 1}.`).join('\n\n');
    const patch = patchFromMarkdown('Authored sections', answer, [current.source]);
    expect(patch.blocks).toHaveLength(12);
    expect(patch.blocks[0]).toMatchObject({ title: 'System', type: 'diagram',
      sourceIds: [`${current.source.canvasId}:${current.source.blockId}`] });
    expect(patch.blocks.slice(1).every(block => block.type === 'text' && block.sourceIds.length === 0)).toBe(true);
    expect(patch.edges).toEqual([]);
    const turn: AnswerCanvasTurn = { id: 7, query: patch.query, answer, sources: [current.source], status: 'complete' };
    act(() => current.result.current.restoreResearchSnapshot({ turns: [turn], edits: emptyResearchEdits(), layout: 'roadmap' }));
    const { document, exported } = await saveAndReload(current, 'roadmap');
    expect(document.blocks).toHaveLength(12);
    expect(document.blocks[0].content).toContain('```mermaid\ngraph LR\nA-->B\n```');
    expect(document.blocks[0].crossLinks).toEqual([{ canvasId: current.source.canvasId, blockId: current.source.blockId, relation: 'related' }]);
    expect(document.blocks.slice(1).every(block => !block.crossLinks?.length)).toBe(true);
    expect(exported).toContain('Retained finding 11.'); expect(exported).not.toContain('Retained finding 12.');
  });

  it.each([
    { answer: '   ', body: 'Research in progress.' },
    { answer: '# Only a heading', body: '# Only a heading' },
  ])('preserves the single-section fallback for $answer through native save', async ({ answer, body }) => {
    const current = await fixture();
    const patch = patchFromMarkdown('Fallback review', answer, [current.source]);
    expect(patch.blocks).toEqual([{ id: 'section-1', title: 'Key finding', content: body, type: 'text',
      sourceIds: [`${current.source.canvasId}:${current.source.blockId}`] }]);
    const turn: AnswerCanvasTurn = { id: 8, query: patch.query, answer, sources: [current.source], status: 'complete' };
    act(() => current.result.current.restoreResearchSnapshot({ turns: [turn], edits: emptyResearchEdits(), layout: 'mindmap' }));
    const { document } = await saveAndReload(current, 'mindmap');
    expect(document.blocks).toHaveLength(1); expect(document.blocks[0].content).toContain(body);
    expect(document.blocks[0].crossLinks).toEqual([{ canvasId: current.source.canvasId, blockId: current.source.blockId, relation: 'related' }]);
  });
});
