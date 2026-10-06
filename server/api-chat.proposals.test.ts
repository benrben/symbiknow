import { expectRestoredCanvas } from './tests/restoration.js';
import { describe, expect, it } from 'vitest';
import { ChatProposalDraft, getChatProposal } from './chat-proposals.js';
import { CanvasStore } from './storage.js';
import { chatHttpFixture, jsonRequest } from './api-chat.test.fixture.js';

async function proposed() {
  const fixture = await chatHttpFixture();
  const before = await fixture.store.getCanvas('product-roadmap');
  const draft = new ChatProposalDraft(fixture.store, before.id, before);
  draft.patch('launch-checklist', { content: '# Selected checklist' }, 'edit');
  draft.patch('roadmap-overview', { content: '# Selected overview' }, 'edit');
  const proposal = draft.publish();
  if (!proposal) throw new Error('Missing public proposal');
  return { ...fixture, before, proposal, route: `/api/chat/proposals/${proposal.id}` };
}

describe('HTTP reviewed chat proposals', () => {
  it('loads a pending proposal, applies all changes with omitted selection, and undoes its durable receipt', async () => {
    const { base, root, before, proposal, route } = await proposed();
    const pending = await fetch(base + route);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual(proposal);
    const applied = await jsonRequest(base, route + '/apply', {});
    expect(applied.status).toBe(200);
    const receipt = await applied.json();
    expect(receipt).toMatchObject({ status: 'applied', applied: ['launch-checklist', 'roadmap-overview'] });
    expect(getChatProposal(new CanvasStore(root), proposal.id)).toEqual(receipt);
    expect(await fetch(base + route).then(response => response.json())).toEqual(receipt);
    const undone = await jsonRequest(base, route + '/undo', {});
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ status: 'reverted', reverted: ['launch-checklist', 'roadmap-overview'] });
    expectRestoredCanvas(await new CanvasStore(root).getCanvas(before.id), before);
  });

  it.each([null, 'launch-checklist', 3, ['launch-checklist', 4]])('rejects malformed changeIds %j before changing the proposal', async changeIds => {
    const { base, root, before, proposal, route } = await proposed();
    const result = await jsonRequest(base, route + '/apply', { changeIds });
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: 'changeIds must be an array of strings' });
    expect(getChatProposal(new CanvasStore(root), proposal.id)).toEqual(proposal);
    expect(await new CanvasStore(root).getCanvas(before.id)).toEqual(before);
  });

  it('propagates selection errors, preserves pending state, and applies only the reviewed subset', async () => {
    const { base, root, before, proposal, route } = await proposed();
    for (const [changeIds, message] of [[[], 'Select at least one proposed change'], [['unknown'], 'Unknown or duplicate change ID'],
      [['launch-checklist', 'launch-checklist'], 'Unknown or duplicate change ID']] as const) {
      const rejected = await jsonRequest(base, route + '/apply', { changeIds });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: message });
      expect(getChatProposal(new CanvasStore(root), proposal.id)).toEqual(proposal);
      expect(await new CanvasStore(root).getCanvas(before.id)).toEqual(before);
    }
    const result = await jsonRequest(base, route + '/apply', { changeIds: ['launch-checklist'] });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ applied: ['launch-checklist'], skipped: [] });
    const saved = await new CanvasStore(root).getCanvas(before.id);
    expect(saved.blocks.find(block => block.id === 'launch-checklist')?.content).toBe('# Selected checklist');
    expect(saved.blocks.find(block => block.id === 'roadmap-overview')).toEqual(before.blocks.find(block => block.id === 'roadmap-overview'));
  });

  it('returns conflict details for stale Apply and stale Undo, with no partial mutation', async () => {
    const { base, store, root, before, route } = await proposed();
    await store.updateBlock(before.id, 'launch-checklist', { title: 'Concurrent preview edit' });
    const beforeApply = await store.getCanvas(before.id);
    const rejected = await jsonRequest(base, route + '/apply', {});
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: expect.any(String), conflicts: [
      { id: 'launch-checklist', reason: 'Document changed since preview' },
    ] });
    expect(await new CanvasStore(root).getCanvas(before.id)).toEqual(beforeApply);
    const applied = await jsonRequest(base, route + '/apply', { changeIds: ['roadmap-overview'] });
    expect(applied.status).toBe(200);
    await store.updateBlock(before.id, 'roadmap-overview', { title: 'Concurrent after-apply edit' });
    const beforeUndo = await store.getCanvas(before.id);
    const undone = await jsonRequest(base, route + '/undo', {});
    expect(undone.status).toBe(409);
    expect(await undone.json()).toMatchObject({ error: expect.any(String), conflicts: [
      { id: 'roadmap-overview', reason: 'Document changed since apply' },
    ] });
    expect(await new CanvasStore(root).getCanvas(before.id)).toEqual(beforeUndo);
  });

  it('propagates unavailable proposal errors through GET, Apply and Undo without losing the server', async () => {
    const { base } = await chatHttpFixture();
    const route = '/api/chat/proposals/00000000-0000-4000-8000-000000000000';
    for (const result of [await fetch(base + route), await jsonRequest(base, route + '/apply', {}),
      await jsonRequest(base, route + '/undo', {})]) {
      expect(result.status).toBe(410);
      expect(await result.json()).toMatchObject({ error: expect.any(String) });
    }
    expect((await fetch(base + '/api/search?q=launch')).status).toBe(200);
  });
});
