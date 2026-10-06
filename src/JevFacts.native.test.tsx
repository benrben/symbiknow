// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JevMutationSummary } from './JevFacts';
import { api } from './api';
import { workspaceFixture, closeWorkspaceFixtures } from './native-workspace.test.fixture';
import { JevWorkspaceFiles } from '../server/jev/workspace';
import { sourceSnapshot } from '../server/jev/stamps';
import type { JevMutation, JevReceipt, JevWorkspaceState } from '../shared/jev-types';

beforeEach(() => { vi.stubEnv('TYPESAFE_API_KEY', ''); });
afterEach(async () => { cleanup(); await closeWorkspaceFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('keeps every historical saved mutation readable with clear empty, cleared, false and nested facts', async () => {
  const fixture = await workspaceFixture();
  const source = sourceSnapshot(fixture.workspace.id, fixture.canvas.id, fixture.canvas.blocks[0]);
  const mutations: JevMutation[] = [
    { kind: 'content', canvasId: fixture.canvas.id, blockId: source.blockId, content: 'A historical reviewed draft.', expectedContentHash: source.contentHash, draftId: 'saved-draft' },
    { kind: 'document', canvasId: fixture.canvas.id, blockId: source.blockId, patch: { purpose: null, archived: false, tags: [], quality: { score: 0.8, at: '2026-10-04T12:00:00Z' } } },
    { kind: 'task_create', canvasId: fixture.canvas.id, task: { title: 'Verify release', detail: 'Read the saved deployment evidence.' } },
    { kind: 'task_update', canvasId: fixture.canvas.id, taskId: 'saved-task', expectedUpdatedAt: '2026-10-04T12:00:00Z', patch: { title: 'Reviewed release task' } },
    { kind: 'task_delete', canvasId: fixture.canvas.id, taskId: 'removed-task', expectedUpdatedAt: '2026-10-04T12:00:00Z', expectedRevision: 2 },
    { kind: 'move', canvasId: fixture.canvas.id, blockId: source.blockId, targetCanvasId: fixture.secondCanvas.id },
    { kind: 'vocabulary', operation: 'activate', term: { id: 'release', kind: 'label', name: 'Release evidence', definition: 'Verified release sources.', aliases: [], state: 'active', version: 1, members: [{ canvasId: source.canvasId, blockId: source.blockId }] } },
    { kind: 'derived', blockId: source.blockId, values: { supported: true, sourcePassages: ['release_checklist', { contentHash: source.contentHash }], missingSources: [] } },
  ];
  const receipts: JevReceipt[] = mutations.map((mutation, index) => ({ id: `historical-${index}`, proposalId: `saved-${index}`, action: 'review_agent_edit',
    actor: 'workspace-owner', createdAt: '2026-10-04T12:00:00Z', before: mutation, after: mutation, sourcesAfter: [source], state: 'applied' }));
  const files = new JevWorkspaceFiles(fixture.root); const state = await files.read(fixture.workspace.id);
  state.receipts.push(...receipts);
  state.proposals.push(...receipts.map(receipt => ({ id: receipt.proposalId, jobId: `job-${receipt.id}`, action: receipt.action,
    createdAt: receipt.createdAt, title: 'Historical saved result', explanation: 'Saved before automatic-only organization.',
    state: 'applied' as const, sources: [source], evidence: [], mutation: receipt.after })));
  await files.write(fixture.workspace.id, state);
  const saved = await api<JevWorkspaceState>(`/workspaces/${fixture.workspace.id}/jev/state`);
  render(<section aria-label="Historical saved results">{saved.receipts.map(receipt => <article key={receipt.id} aria-label={receipt.after.kind}><JevMutationSummary mutation={receipt.after}/></article>)}</section>);
  const history = screen.getByRole('region', { name: 'Historical saved results' });
  expect(within(history).getByText('A historical reviewed draft.')).toBeTruthy();
  const document = within(history).getByRole('article', { name: 'document' });
  expect(within(document).getByText('Clear this value')).toBeTruthy(); expect(within(document).getByText('No')).toBeTruthy();
  expect(within(document).getByText('None')).toBeTruthy(); expect(within(document).getByText('0.8')).toBeTruthy();
  expect(within(document).getByText('Score')).toBeTruthy(); expect(within(document).getByText('2026-10-04T12:00:00Z')).toBeTruthy();
  expect(within(history).getByText('Create task: Verify release')).toBeTruthy();
  expect(within(history).getByText('Read the saved deployment evidence.')).toBeTruthy();
  expect(within(history).getByText('Reviewed release task')).toBeTruthy();
  expect(within(history).getByText('Delete the selected task after checking its current revision.')).toBeTruthy();
  expect(within(history).getByText(`Move the source document to canvas ${fixture.secondCanvas.id}.`)).toBeTruthy();
  expect(within(history).getByText('Release evidence')).toBeTruthy(); expect(within(history).getByText('1 proposed members · active')).toBeTruthy();
  const derived = within(history).getByRole('article', { name: 'derived' });
  expect(within(derived).getByText('Yes')).toBeTruthy(); expect(within(derived).getByText('release checklist')).toBeTruthy();
  expect(within(derived).getByText('Content Hash')).toBeTruthy(); expect(within(derived).getByText(source.contentHash)).toBeTruthy();
  expect(within(history).queryByRole('button')).toBeNull();
  expect((await files.read(fixture.workspace.id)).receipts).toEqual(receipts);
  expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
});
