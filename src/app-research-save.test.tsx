// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../server/index';
import type { AnswerCanvasTurn, AnswerSource } from '../shared/answer-canvas';
import type { CanvasDocument, WorkspaceSummary } from '../shared/types';
import { useAppState } from './app-state';
import { useResearchSession } from './app-research';
import { emptyResearchEdits } from './research-edits';

const originalFetch = globalThis.fetch;
const opened: Array<{ server: Server; dataDir: string }> = [];
const sources: AnswerSource[] = [
  { canvasId: 'product-roadmap', canvasName: 'Product Roadmap', blockId: 'roadmap-overview', title: 'Roadmap', excerpt: 'Evidence', relevance: 1 },
  { canvasId: 'product-roadmap', canvasName: 'Product Roadmap', blockId: 'removed', title: 'Removed', excerpt: '', relevance: 1 },
  { canvasId: 'foreign-workspace', canvasName: 'Foreign', blockId: 'private', title: 'Outside', excerpt: '', relevance: 1 },
];
const turn: AnswerCanvasTurn = { id: 1, query: 'Should we ship?', answer: '', status: 'complete', sources, patch: {
  query: 'Should we ship?', blocks: [
    { id: 'evidence', type: 'text', title: 'Evidence', content: 'Tests pass', sourceIds: sources.map(source => `${source.canvasId}:${source.blockId}`) },
    { id: 'decision', type: 'section', title: 'Decision', content: 'Review release', sourceIds: [] },
    { id: 'next', type: 'task', kind: 'slides', title: 'Next', content: '# Ship', sourceIds: [] },
  ], edges: [{ from: 'evidence', to: 'decision' }],
} };
function session() {
  return renderHook(() => { const state = useAppState(); return { state, actions: useResearchSession(state) }; });
}
async function fixture(intercept?: (route: string, init: RequestInit | undefined) => Response | undefined) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-research-save-'));
  const server = await createApiServer({ dataDir });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, dataDir });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const base = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => intercept?.(url.replace('?summary=1', ''), init) ?? originalFetch(base + url, init));
  const workspaces = await originalFetch(base + '/api/workspaces').then(response => response.json()) as WorkspaceSummary[];
  const canvas = await originalFetch(base + '/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
  const hook = session();
  act(() => { hook.result.current.state.setWorkspaces(workspaces); hook.result.current.state.setCanvas(canvas); hook.result.current.state.setAnswerTurns([turn]); });
  return { ...hook, base, workspaces, canvas };
}
async function documents(base: string) {
  return originalFetch(base + '/api/workspaces').then(response => response.json()) as Promise<WorkspaceSummary[]>;
}
function fail(message: string) { return new Response(JSON.stringify({ error: message }), { status: 503, headers: { 'content-type': 'application/json' } }); }
beforeEach(() => { window.localStorage.clear(); });
afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const { server, dataDir } of opened.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

describe('saving research through the real canvas API', () => {
  it('persists edited content, remaps local links, and keeps only available citations', async () => {
    const { result, base } = await fixture();
    act(() => result.current.actions.changeResearchEdits({ ...emptyResearchEdits(), changed: { '1:evidence': { title: 'Reviewed evidence', x: 150, tags: ['review'] } }, added: [
      { id: 'manual', turnId: 1, type: 'text', title: 'Manual note', content: 'User context', markdown: '', sources: [], x: 0, y: 0 },
    ] }));
    let saved!: { id: string; name: string };
    await act(async () => { saved = await result.current.actions.saveResearchCanvas('roadmap'); });
    const document = await originalFetch(base + '/api/canvases/' + saved.id).then(response => response.json()) as CanvasDocument;
    expect(saved.name).toBe('Research — Should we ship?');
    expect(document.blocks).toHaveLength(4);
    const evidence = document.blocks.find(block => block.title === 'Reviewed evidence')!;
    const decision = document.blocks.find(block => block.title === 'Decision')!;
    expect(evidence).toMatchObject({ title: 'Reviewed evidence', x: 150, tags: ['review'], links: [decision.id],
      crossLinks: [{ canvasId: 'product-roadmap', blockId: 'roadmap-overview', relation: 'related' }] });
    expect(evidence.content).toContain('# Reviewed evidence');
    expect(document.blocks.find(block => block.title === 'Next')).toMatchObject({ kind: 'slides', content: '# Ship' });
    expect(document.blocks.find(block => block.title === 'Manual note')).toMatchObject({ kind: 'markdown' });
    expect(result.current.state.workspaces.flatMap(workspace => workspace.canvases).some(canvas => canvas.id === saved.id)).toBe(true);
    expect(result.current.state.researchSaveCount).toBe(1);
  });

  it('names successive durable copies and updates the save count', async () => {
    const { result, base } = await fixture();
    act(() => result.current.state.setAnswerTurns([{ ...turn, sources: [], patch: { ...turn.patch!,
      blocks: [turn.patch!.blocks[0]], edges: [] } }]));
    const saved: Array<{ id: string; name: string }> = [];
    for (const layout of ['roadmap', 'architecture'] as const) {
      await act(async () => { saved.push(await result.current.actions.saveResearchCanvas(layout)); });
    }
    expect(saved.map(canvas => canvas.name)).toEqual(['Research — Should we ship?', 'Research — Should we ship? (2)']);
    expect(saved[0].id).not.toBe(saved[1].id);
    for (const copy of saved) {
      const document = await originalFetch(base + '/api/canvases/' + copy.id).then(response => response.json()) as CanvasDocument;
      expect(document.blocks).toHaveLength(1);
      expect(document.blocks[0]).toMatchObject({ title: 'Evidence', content: expect.stringContaining('Tests pass') });
    }
    expect(result.current.state.researchSaveCount).toBe(2);
  });

  it('uses the first workspace when no canvas is open and ignores unavailable source canvases', async () => {
    const { result, base, workspaces } = await fixture(route => route === '/api/canvases/product-roadmap' ? fail('Source unavailable') : undefined);
    act(() => result.current.state.setCanvas(null));
    let saved!: { id: string; name: string };
    await act(async () => { saved = await result.current.actions.saveResearchCanvas('mindmap'); });
    const document = await originalFetch(base + '/api/canvases/' + saved.id).then(response => response.json()) as CanvasDocument;
    expect(document.workspaceId).toBe(workspaces[0].id);
    expect(document.blocks.every(block => !block.crossLinks?.length)).toBe(true);
    expect(document.blocks.find(block => block.title === 'Evidence')?.links).toEqual([document.blocks.find(block => block.title === 'Decision')?.id]);
  });

  it('saves without citations when the current workspace is absent from the cached workspace list', async () => {
    const { result, base } = await fixture();
    act(() => result.current.state.setWorkspaces([]));
    let saved!: { id: string; name: string };
    await act(async () => { saved = await result.current.actions.saveResearchCanvas('mindmap'); });
    const document = await originalFetch(base + '/api/canvases/' + saved.id).then(response => response.json()) as CanvasDocument;
    expect(document.blocks.every(block => !block.crossLinks?.length)).toBe(true);
  });

  it.each(['workspace', 'answers'])('refuses a save without %s before writing anything', async missing => {
    const { result, base, workspaces } = await fixture();
    act(() => {
      if (missing === 'workspace') { result.current.state.setCanvas(null); result.current.state.setWorkspaces([]); }
      else result.current.state.setAnswerTurns([]);
    });
    await expect(result.current.actions.saveResearchCanvas('mindmap')).rejects.toThrow('Open a workspace and ask a research question first.');
    expect(await documents(base)).toEqual(workspaces);
    expect(result.current.state.researchSaveCount).toBe(0);
  });

  it.each(['blocks', 'links'])('removes an incomplete canvas after a %s write fails and permits a clean retry', async stage => {
    let failed = false;
    let writes = 0;
    const { result, base, workspaces } = await fixture((route, init) => {
      const blockWrite = init?.method === 'POST' && /\/canvases\/[^/]+\/blocks$/.test(route);
      const linkWrite = init?.method === 'PUT' && /\/canvases\/[^/]+\/blocks\//.test(route);
      if (blockWrite) writes++;
      if (!failed && ((stage === 'blocks' && blockWrite && writes === 2) || (stage === 'links' && linkWrite))) {
        failed = true; return fail('Write temporarily unavailable');
      }
    });
    await act(async () => { await expect(result.current.actions.saveResearchCanvas('mindmap')).rejects.toThrow('Write temporarily unavailable'); });
    expect(await documents(base)).toEqual(workspaces);
    expect(result.current.state.researchSaveCount).toBe(0);
    expect(result.current.state.answerTurns).toEqual([turn]);
    await act(async () => { await result.current.actions.saveResearchCanvas('mindmap'); });
    const after = await documents(base);
    expect(after.flatMap(workspace => workspace.canvases).length).toBe(workspaces.flatMap(workspace => workspace.canvases).length + 1);
    expect(result.current.state.researchSaveCount).toBe(1);
  });

  it('reports a completed save when workspace refresh fails and retains the saved canvas for navigation', async () => {
    let unavailable = true;
    const { result, base, workspaces } = await fixture(route => route === '/api/workspaces' && unavailable ? fail('Refresh unavailable') : undefined);
    await originalFetch(base + '/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Other team' }) });
    const current = await documents(base);
    act(() => result.current.state.setWorkspaces(current));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let saved!: { id: string; name: string };
    await act(async () => { saved = await result.current.actions.saveResearchCanvas('mindmap'); });
    expect(result.current.state.researchSaveCount).toBe(1);
    expect(result.current.state.workspaces.flatMap(workspace => workspace.canvases)).toContainEqual({ id: saved.id, name: saved.name });
    expect(warning).toHaveBeenCalledWith('Research was saved, but workspace refresh failed.', expect.any(Error));
    unavailable = false;
    expect((await documents(base)).flatMap(workspace => workspace.canvases)).toHaveLength(workspaces.flatMap(workspace => workspace.canvases).length + 1);
    expect(result.current.state.workspaces.find(workspace => workspace.name === 'Other team')).toEqual(current.find(workspace => workspace.name === 'Other team'));
    expect((await originalFetch(base + '/api/canvases/' + saved.id)).status).toBe(200);
  });

  it('identifies the incomplete canvas when cleanup is also unavailable, preserving the research for recovery', async () => {
    const { result, base } = await fixture((route, init) => {
      if (init?.method === 'POST' && /\/blocks$/.test(route)) return fail('Write failed');
      if (init?.method === 'DELETE') return fail('Cleanup failed');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failure!: Error;
    await act(async () => {
      try { await result.current.actions.saveResearchCanvas('mindmap'); }
      catch (reason) { failure = reason as Error; }
    });
    const incomplete = (await documents(base)).flatMap(workspace => workspace.canvases).find(canvas => canvas.name.startsWith('Research —'))!;
    expect(failure.message).toContain('Write failed');
    expect(failure.message).toContain(`Incomplete canvas ${incomplete.id} could not be removed. Delete it before retrying.`);
    expect(warning).toHaveBeenCalledWith('Incomplete research canvas could not be removed.', expect.any(Error));
    expect(result.current.state.answerTurns).toEqual([turn]);
    expect(result.current.state.researchSaveCount).toBe(0);
  });
});
