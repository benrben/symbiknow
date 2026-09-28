import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';
import type { JevAnswer, JevDecider, JevQuestion } from './jev.js';

const opened: Array<{ server: Server; directory: string }> = [];

function answer(id: string, question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: id.includes('stale') ? 0.9 : 0.1 };
  if (question.type === 'score') return { type: 'score', score: 0, confidence: 0.95,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), Number(index === 0)])) };
  const keys = Object.keys(question.criteria);
  const selected = id === 'intake_canvas' && keys.includes('c1') ? 'c1'
    : id.endsWith('_purpose') && keys.includes('guide') ? 'guide'
      : id.endsWith('_domain') && keys.includes('engineering') ? 'engineering'
        : id === 'intake_area' && keys.includes('software_engineering') ? 'software_engineering'
          : keys.includes('none') ? 'none' : keys[0];
  return { type: 'choice', choice: selected, confidence: 0.95,
    probabilities: Object.fromEntries(keys.map(key => [key, Number(key === selected)])) };
}

async function fixture(decider: JevDecider): Promise<{ base: string; store: CanvasStore; canvasId: string; blockIds: string[] }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'symbiknow-jev-experience-'));
  const store = new CanvasStore(directory);
  await store.init();
  await store.updateSettings({ jevApiKey: 'test-key', reviewers: '' });
  const workspace = await store.createWorkspace({ name: 'Experience tests' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Guides' });
  const blocks = [];
  for (const title of ['Install client', 'Configure client', 'Deploy client']) {
    blocks.push(await store.createBlock(canvas.id, { title, content: `# ${title}\nDo this to prepare the client.` }));
  }
  const server = await createApiServer({ dataDir: directory, jevDecider: decider });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, directory });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  return { base: `http://127.0.0.1:${address.port}`, store, canvasId: canvas.id, blockIds: blocks.map(block => block.id) };
}

async function post(base: string, route: string, body: unknown) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

afterEach(async () => {
  for (const { server, directory } of opened.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

describe('Jev document experiences', () => {
  it('targets one document, validates families, and records exact source provenance', async () => {
    const calls: string[][] = [];
    const decider: JevDecider = async (_key, _state, questions) => {
      calls.push(Object.keys(questions));
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(id, question)]));
    };
    const { base, canvasId, blockIds } = await fixture(decider);
    const route = `/api/canvases/${canvasId}/insights`;
    expect((await post(base, route, { blockIds: [blockIds[0]], families: ['imaginary'] })).status).toBe(400);
    const result = await post(base, route, { blockIds: [blockIds[0]], families: ['purpose'] });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ analyzed: 1, total: 3 });
    const items = result.body.items as Array<{ blockIds: string[]; evidence: Array<{ questionId: string; sourceIds: string[]; sourceHashes: Record<string, string> }> }>;
    expect(items).toHaveLength(1);
    expect(items[0].blockIds).toEqual([blockIds[0]]);
    expect(items[0].evidence[0]).toMatchObject({ questionId: 'd0_purpose', sourceIds: [blockIds[0]] });
    expect(items[0].evidence[0].sourceHashes[blockIds[0]]).toMatch(/^[a-f0-9]{16}$/);
    expect(calls).toEqual([['d0_purpose']]);
  });

  it('reviews at most two changed documents and keeps failures visible', async () => {
    const decider = vi.fn<JevDecider>(async (_key, _state, questions) =>
      Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(id, question)])));
    const { base, canvasId, blockIds, store } = await fixture(decider);
    const first = await fetch(`${base}/api/canvases/${canvasId}/jev-inbox`);
    expect(first.status).toBe(200);
    const body = await first.json() as { checkedBlockIds: string[]; pendingBlockIds: string[]; items: Array<{ id: string }>;
      errors: unknown[] };
    expect(body.checkedBlockIds).toHaveLength(2);
    expect(body.pendingBlockIds).toEqual([blockIds[2]]);
    expect(body.errors).toEqual([]);
    expect(body.items.length).toBeGreaterThan(0);
    const next = await fetch(`${base}/api/canvases/${canvasId}/jev-inbox`).then(response => response.json()) as typeof body;
    expect(next.checkedBlockIds).toHaveLength(3);
    expect(next.pendingBlockIds).toEqual([]);
    const calls = decider.mock.calls.length;
    await fetch(`${base}/api/canvases/${canvasId}/jev-inbox`);
    expect(decider).toHaveBeenCalledTimes(calls);
    const dismissed = await post(base, `/api/canvases/${canvasId}/jev-inbox/${body.items[0].id}/dismiss`, {});
    expect(dismissed.status).toBe(200);
    expect((dismissed.body.items as Array<{ id: string }>).some(item => item.id === body.items[0].id)).toBe(false);
    await store.updateBlock(canvasId, blockIds[0], { content: '# Updated\nNew details.' });
    const changed = await fetch(`${base}/api/canvases/${canvasId}/jev-inbox`).then(response => response.json()) as { pendingBlockIds: string[] };
    expect(changed.pendingBlockIds).toEqual([]);
    expect(decider.mock.calls.length).toBeGreaterThan(calls);
  });

  it('keeps failed inbox checks visible and retries only when requested', async () => {
    const decider = vi.fn<JevDecider>(async () => { throw new Error('Jev is unavailable'); });
    const { base, canvasId } = await fixture(decider);
    const first = await fetch(`${base}/api/canvases/${canvasId}/jev-inbox`).then(response => response.json()) as
      { errors: Array<{ blockId: string; message: string }>; pendingBlockIds: string[] };
    expect(first.errors).toHaveLength(2);
    expect(first.errors[0].message).toContain('unavailable');
    const second = await fetch(`${base}/api/canvases/${canvasId}/jev-inbox`).then(response => response.json()) as typeof first;
    expect(second.errors).toHaveLength(3);
    expect(second.pendingBlockIds).toEqual([]);
    const count = decider.mock.calls.length;
    const third = await fetch(`${base}/api/canvases/${canvasId}/jev-inbox`).then(response => response.json()) as typeof first;
    expect(third.errors).toEqual(second.errors);
    expect(decider).toHaveBeenCalledTimes(count);
    await fetch(`${base}/api/canvases/${canvasId}/jev-inbox?retry=1`);
    expect(decider.mock.calls.length).toBeGreaterThan(count);
  });

  it('previews intake without saving and recommends an existing canvas and labels', async () => {
    const decider = vi.fn<JevDecider>(async (_key, _state, questions) =>
      Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(id, question)])));
    const { base, canvasId, store, blockIds } = await fixture(decider);
    const before = await store.getCanvas(canvasId);
    const draft = { title: 'Client guide', content: '# Client guide\nInstall and configure the client.', kind: 'markdown' };
    const result = await post(base, `/api/canvases/${canvasId}/intake/preview`, draft);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ canvasId, purpose: 'guide' });
    expect(result.body.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ questionId: 'intake_purpose' })]));
    expect((await store.getCanvas(canvasId)).blocks).toEqual(before.blocks);
    const calls = decider.mock.calls.length;
    await post(base, `/api/canvases/${canvasId}/intake/preview`, draft);
    expect(decider).toHaveBeenCalledTimes(calls);
    await store.updateBlock(canvasId, blockIds[0], { content: '# Install client\nNew installation details for this client.' });
    await post(base, `/api/canvases/${canvasId}/intake/preview`, draft);
    expect(decider.mock.calls.length).toBeGreaterThan(calls);
  });
});
