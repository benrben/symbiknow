// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { CanvasStore } from '../server/storage';
import { JevWorkspaceFiles } from '../server/jev/workspace';
import { sourceSnapshot } from '../server/jev/stamps';
import { assistantFixture, installAssistantBrowser, jsonBody } from './AppAssistantPanel.test.helpers';

installAssistantBrowser();

it('shows both saved duplicate cards and opens the related source through the full App', async () => {
  let duplicate!: CanvasBlock;
  await assistantFixture(undefined, false, async (request, root) => {
    const store = new CanvasStore(root); await store.ensureJevStamps('product-roadmap');
    const canvas = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
    const original = canvas.blocks[0];
    duplicate = await request(`/api/canvases/${canvas.id}/blocks`, jsonBody({ title: 'Roadmap exact copy', content: original.content, x: 100, y: 100 })).then(response => response.json()) as CanvasBlock;
    duplicate = await request(`/api/canvases/${canvas.id}/blocks/${duplicate.id}`, { ...jsonBody({ x: 100, y: 100 }), method: 'PUT' }).then(response => response.json()) as CanvasBlock;
    const files = new JevWorkspaceFiles(root); const state = await files.read(canvas.workspaceId);
    const sources = [original, duplicate].map(block => sourceSnapshot(canvas.workspaceId, canvas.id, block));
    const mutation = { kind: 'derived' as const, blockId: original.id, values: { kind: 'duplicate', targetId: duplicate.id } };
    state.proposals.push({ id: 'native-copy-finding', jobId: 'native-copy-check', action: 'flag_duplicate', title: 'Compare possible duplicates',
      explanation: 'Exact content', state: 'applied', createdAt: new Date().toISOString(), sources, evidence: [], mutation });
    state.receipts.push({ id: 'native-copy-receipt', proposalId: 'native-copy-finding', action: 'flag_duplicate', actor: 'jev-workspace-automation',
      automatic: true, createdAt: new Date().toISOString(), sourcesAfter: sources, state: 'applied', before: mutation, after: mutation });
    await files.write(canvas.workspaceId, state);
  });
  const badge = await screen.findByRole('button', { name: 'Possible duplicate: Roadmap exact copy' });
  expect(await screen.findByRole('button', { name: 'Possible duplicate: Roadmap overview' })).toBeTruthy();
  fireEvent.click(badge);
  const reader = await screen.findByRole('dialog', { name: 'Roadmap exact copy full page' });
  await waitFor(() => expect(reader.textContent).toContain('Our shared launch plan'));
  expect(new URL(window.location.href).searchParams.get('doc')).toBe(duplicate.id);
  fireEvent.click(within(reader).getByRole('button', { name: '← Back to canvas' }));
});

it('shows optional Reflex recovery status while the native canvas remains editable', async () => {
  await assistantFixture(undefined, false, async (_request, root) => {
    const files = new JevWorkspaceFiles(root); const state = await files.read('acme-team');
    await files.write('acme-team', state); await writeFile(files.file('acme-team'), '{broken');
  });
  expect(await screen.findByText('Automatic findings could not load. Open Symbi Reflex to retry; your documents are available.')).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'Edit Roadmap overview' })).toBeTruthy();
});
