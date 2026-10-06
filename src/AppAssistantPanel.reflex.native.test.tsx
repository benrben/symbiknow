// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { assistantFixture, installAssistantBrowser, jsonBody } from './AppAssistantPanel.test.helpers';
import { JevWorkspaceFiles } from '../server/jev/workspace';
import { CanvasStore } from '../server/storage';
import { sourceSnapshot } from '../server/jev/stamps';
import type { CanvasBlock, CanvasDocument } from '../shared/types';

installAssistantBrowser();

async function toggleDetails(scope: HTMLElement, title: string) {
  const summary = await within(scope).findByText(title, { selector: 'summary' });
  await act(async () => { fireEvent.click(summary); await new Promise(resolve => setTimeout(resolve, 0)); });
}

it.each([false, true])('opens saved Reflex activity and exact evidence from the full App across canvases %s', async remote => {
  let targetCanvas!: CanvasDocument; let target!: CanvasBlock; let sourceCanvas!: CanvasDocument;
  const fixture = await assistantFixture(undefined, false, async (request, root) => {
    const store = new CanvasStore(root); await store.ensureJevStamps('product-roadmap');
    sourceCanvas = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
    targetCanvas = remote ? await request(`/api/workspaces/${sourceCanvas.workspaceId}/canvases`, jsonBody({ name: 'Release references' })).then(response => response.json()) as CanvasDocument : sourceCanvas;
    target = remote ? await request(`/api/canvases/${targetCanvas.id}/blocks`, jsonBody({ title: 'Remote release evidence', content: '# Remote release evidence\nUse the saved checklist.' })).then(response => response.json()) as CanvasBlock : sourceCanvas.blocks[0];
    const source = sourceSnapshot(sourceCanvas.workspaceId, targetCanvas.id, target);
    const current = sourceSnapshot(sourceCanvas.workspaceId, sourceCanvas.id, sourceCanvas.blocks[0]);
    const sources = remote ? [source, current] : [source];
    const quote = target.content.split('\n')[0];
    const files = new JevWorkspaceFiles(root); const state = await files.read(sourceCanvas.workspaceId);
    const mutation = { kind: 'derived' as const, blockId: source.blockId, values: { supported: true } };
    state.proposals.push({ id: 'saved-support', jobId: 'saved-support-check', action: 'recall', title: 'Saved release support', explanation: 'The saved passage supports this release.',
      state: 'applied', createdAt: '2020-01-01T00:00:00Z', sources, evidence: [{ source, start: 0, end: quote.length, quote }], mutation });
    state.receipts.push({ id: 'saved-support-result', proposalId: 'saved-support', action: 'recall', automatic: true, actor: 'automation', createdAt: '2020-01-01T00:00:00Z',
      state: 'applied', before: { kind: 'derived', values: {} }, after: mutation, sourcesAfter: sources });
    await files.write(sourceCanvas.workspaceId, state);
  });
  fireEvent.click(screen.getByRole('tab', { name: 'Symbi Reflex' }));
  let panel = await screen.findByRole('region', { name: 'Symbi Reflex organization' });
  await toggleDetails(panel, 'Automatic findings and saved results');
  await within(panel).findByText('Saved release support');
  fireEvent.click(screen.getByRole('button', { name: 'Symbi settings' }));
  await within(panel).findByLabelText('TypeSafe API key');
  expect(within(panel).queryByLabelText('Organization mode')).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: 'Back to thresholds' }));
  await toggleDetails(panel, 'Automatic findings and saved results');
  await within(panel).findByText('Saved release support');
  await toggleDetails(panel, 'Saved activity · 1 results');
  fireEvent.click(within(panel).getByRole('button', { name: 'Show on canvas' }));
  await screen.findByText(targetCanvas.name, { selector: '.canvas-label h1' });
  await waitFor(() => expect(document.querySelector(`[data-id="${target.id}"]`)?.getAttribute('class')).toContain('selected'));
  if (remote) {
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Product Roadmap' }));
    await screen.findByText(sourceCanvas.name, { selector: '.canvas-label h1' });
    panel = await screen.findByRole('region', { name: 'Symbi Reflex organization' });
    await toggleDetails(panel, 'Automatic findings and saved results');
    await within(panel).findByText('Saved release support');
  }
  await toggleDetails(panel, 'Finding details and source evidence');
  fireEvent.click(within(panel).getByRole('button', { name: 'Open source passage' }));
  const reader = await screen.findByRole('dialog', { name: `${target.title} full page` });
  const context = await within(reader).findByLabelText('Source context from Symbi Reflex');
  expect(within(context).getByText(target.content.split('\n')[0])).toBeTruthy();
  expect(within(context).getByText('This passage appears in the current document.')).toBeTruthy();
  expect(new URL(window.location.href).searchParams.get('canvas')).toBe(targetCanvas.id);
  expect((await fixture.read(targetCanvas.id)).blocks.find(block => block.id === target.id)).toEqual(target);
});

it('keeps automatic organization available when its initial canvas-source refresh fails', async () => {
  let failSources = false; let sourceReads = 0;
  await assistantFixture(async (route, init, forward) => {
    const response = await forward();
    if (route === '/api/canvases/product-roadmap' && !init.method) sourceReads++;
    return failSources && route === '/api/canvases/product-roadmap' && !init.method
      ? Response.json({ error: 'Saved source read temporarily unavailable' }, { status: 503 }) : response;
  }, false);
  failSources = true;
  fireEvent.click(screen.getByRole('tab', { name: 'Symbi Reflex' }));
  await screen.findByText('Saved source read temporarily unavailable');
  expect(await screen.findByRole('heading', { name: 'Symbi Reflex is active' })).toBeTruthy();
  failSources = false; const beforeRetry = sourceReads;
  fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Symbi Reflex' }));
  await waitFor(() => expect(sourceReads).toBeGreaterThan(beforeRetry));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
  expect(screen.queryByText('Saved source read temporarily unavailable')).toBeNull();
  await toggleDetails(screen.getByRole('region', { name: 'Symbi Reflex organization' }), 'Automatic findings and saved results');
  expect(await screen.findByRole('region', { name: 'Automatic findings' })).toBeTruthy();
});
