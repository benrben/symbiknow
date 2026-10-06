// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import type { AnswerCanvasTurn, AnswerSource } from '../shared/answer-canvas';
import { useAppModel } from './app-model';
import { researchStorageKey } from './app-state-helpers';
import { emptyResearchEdits } from './research-edits';

const nativeFetch = globalThis.fetch;
const opened: Array<{ server: Server; root: string }> = [];
async function fixture(snapshot: (turn: AnswerCanvasTurn) => unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-research-restore-'));
  const store = new CanvasStore(root); await store.init();
  const canvas = await store.getCanvas('product-roadmap'); const block = canvas.blocks[0];
  const source: AnswerSource = { canvasId: canvas.id, canvasName: canvas.name, blockId: block.id,
    title: block.title, excerpt: block.content.slice(0, 120), relevance: 1, contentHash: block.contentHash };
  const turn: AnswerCanvasTurn = { id: 1, query: 'What evidence should survive reload?',
    answer: '# Retained answer\nKeep the original research.', status: 'working', sources: [source] };
  localStorage.setItem(researchStorageKey, JSON.stringify(snapshot(turn)));
  const server = await createApiServer({ dataDir: root }); opened.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native port');
  const base = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal('fetch', (route: string, init?: RequestInit) => nativeFetch(base + route, init));
  const hook = renderHook(useAppModel);
  await waitFor(() => expect(hook.result.current.canvas?.id).toBe(canvas.id));
  return { ...hook, root, canvas, turn, source };
}
async function verifyRecoveredSave(current: Awaited<ReturnType<typeof fixture>>) {
  let saved!: { id: string; name: string };
  await act(async () => { saved = await current.result.current.saveResearchCanvas(current.result.current.researchLayout); });
  const fresh = new CanvasStore(current.root); await fresh.init();
  const document = await fresh.getCanvas(saved.id, true);
  expect(document.blocks).toHaveLength(1);
  expect(document.blocks[0]).toMatchObject({ title: 'Retained answer', crossLinks: [
    { canvasId: current.source.canvasId, blockId: current.source.blockId, relation: 'related' },
  ] });
  expect(document.blocks[0].content).toContain('Keep the original research.');
  expect(await fresh.getCanvas(current.canvas.id, true)).toEqual(current.canvas);
  current.unmount();
  const reloaded = renderHook(useAppModel);
  await waitFor(() => expect(reloaded.result.current.canvas?.id).toBe(current.canvas.id));
  expect(reloaded.result.current.answerTurns).toEqual([{ ...current.turn, status: 'stopped' }]);
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/?canvas=product-roadmap'); });
afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('research session recovery through native App, HTTP, disk and remount', () => {
  it('retains valid research beside a malformed saved turn', async () => {
    const current = await fixture(turn => ({ turns: [turn, null], edits: emptyResearchEdits(), layout: 'roadmap' }));
    expect(current.result.current.answerTurns).toEqual([{ ...current.turn, status: 'stopped' }]);
    expect(current.result.current.researchLayout).toBe('roadmap');
    await verifyRecoveredSave(current);
  });
  it('rejects malformed saved sources without discarding neighboring valid research', async () => {
    const current = await fixture(turn => ({ turns: [turn, { ...turn, id: 2, sources: [null] }], edits: emptyResearchEdits(), layout: 'mindmap' }));
    await verifyRecoveredSave(current);
    expect(current.result.current.answerTurns).toEqual([{ ...current.turn, status: 'stopped' }]);
  });
  it('retains valid answers when saved edits contain an unusable added block', async () => {
    const current = await fixture(turn => ({ turns: [turn], edits: { ...emptyResearchEdits(), added: [null] }, layout: 'architecture' }));
    await verifyRecoveredSave(current);
    expect(current.result.current.researchState.edits).toEqual(emptyResearchEdits());
    expect(current.result.current.answerTurns).toEqual([{ ...current.turn, status: 'stopped' }]);
  });
  it('retains valid manual blocks and reviewed edits beside damaged edit entries', async () => {
    const manual = { id: 'manual', turnId: 1, type: 'text' as const, title: 'Manual evidence', content: 'Keep this human note.', markdown: '', sources: [], x: 200, y: 400 };
    const current = await fixture(turn => ({ turns: [turn], layout: 'mindmap', edits: {
      added: [manual, null], changed: { '1:section-1': { title: 'Reviewed answer' }, damaged: { content: {} } },
      deleted: ['removed', null], addedEdges: [{ source: 'manual', target: '1:section-1', label: 'supports' }, null], deletedEdges: ['obsolete', null],
    } }));
    let saved!: { id: string; name: string };
    await act(async () => { saved = await current.result.current.saveResearchCanvas('mindmap'); });
    const fresh = new CanvasStore(current.root); await fresh.init();
    const document = await fresh.getCanvas(saved.id, true);
    expect(document.blocks).toHaveLength(2);
    const answer = document.blocks.find(block => block.title === 'Reviewed answer')!;
    expect(document.blocks.find(block => block.title === manual.title)).toMatchObject({ x: manual.x, y: manual.y, links: [answer.id] });
    expect(answer.content).toContain('Keep the original research.');
    expect(current.result.current.researchState.edits).toEqual({ added: [manual], changed: { '1:section-1': { title: 'Reviewed answer' } },
      deleted: ['removed'], addedEdges: [{ source: 'manual', target: '1:section-1', label: 'supports' }], deletedEdges: ['obsolete'] });
    expect(await fresh.getCanvas(current.canvas.id, true)).toEqual(current.canvas);
  });
});
