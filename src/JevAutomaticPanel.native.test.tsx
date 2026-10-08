// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JevPanel } from './JevPanel';
import { useJevWorkspace } from './useJevWorkspace';
import { api } from './api';
import { workspaceFixture, closeWorkspaceFixtures } from './native-workspace.test.fixture';
import { JevWorkspaceFiles } from '../server/jev/workspace';
import { sourceSnapshot } from '../server/jev/stamps';
import { acceptanceReflexProvider } from '../features/acceptance-reflex-provider';
import { jevActions, type JevProposal, type JevWorkspaceState } from '../shared/jev-types';
import { jevActionLabels } from '../shared/jev-action-labels';
import type { CanvasDocument } from '../shared/types';

type Fixture = Awaited<ReturnType<typeof workspaceFixture>>;
const releases: Array<() => void> = [];
beforeEach(() => { vi.stubEnv('TYPESAFE_API_KEY', ''); });
afterEach(async () => { releases.splice(0).forEach(release => release()); cleanup(); await closeWorkspaceFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function NativePanel({ fixture, settingsRequest = 0, sourceOnly = false, opened = () => undefined }: { fixture: Fixture; settingsRequest?: number; sourceOnly?: boolean; opened?: (value: string) => void }) {
  const [canvas, setCanvas] = useState<CanvasDocument | null>(fixture.canvas);
  const [request, setRequest] = useState(settingsRequest);
  const model = useJevWorkspace(fixture.workspace.id, true, async () => setCanvas(await fixture.reload()));
  const visibleCanvas = sourceOnly && canvas ? { ...canvas, blocks: canvas.blocks.slice(0, 1) } : canvas;
  return <><button type="button" onClick={() => setCanvas(null)}>Clear selected canvas</button>
    <button type="button" onClick={() => setRequest(value => value + 1)}>Symbi settings</button>
    <JevPanel model={model} canvas={visibleCanvas} settingsRequest={request} onAddSource={() => { throw new Error('Automatic panel must not request a source'); }}
      onOpenDocument={(canvasId, id) => opened(`${canvasId}:${id}`)} onOpenEvidence={passage => opened(passage.quote)}
      onShowCanvas={(canvasId, id) => opened(`${canvasId}:${id}`)}/></>;
}

async function toggleDetails(scope: HTMLElement, title: string) {
  const summary = await within(scope).findByText(title, { selector: 'summary' });
  await act(async () => { fireEvent.click(summary); await new Promise(resolve => setTimeout(resolve, 0)); });
}

async function mountPanel(fixture: Fixture, opened?: (value: string) => void, sourceOnly = false, resultsOpen = true) {
  fixture.canvas = await fixture.reload();
  const held = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  const view = render(<NativePanel fixture={fixture} opened={opened} sourceOnly={sourceOnly}/>);
  const panel = screen.getByRole('region', { name: 'Symbi Reflex organization' });
  expect(within(panel).getByText('Opening workspace organization…')).toBeTruthy();
  expect((await held.response).ok).toBe(true);
  await act(async () => { await held.release(); });
  await within(panel).findByRole('heading', { name: 'Symbi Reflex is active' });
  if (resultsOpen) {
    await toggleDetails(panel, 'Automatic findings and saved results');
    await within(panel).findByRole('region', { name: 'Automatic findings' });
  }
  return { ...view, panel };
}

function expectAutomaticOnly(panel: HTMLElement) {
  expect(within(panel).queryByRole('textbox', { name: 'Message Symbi Reflex' })).toBeNull();
  expect(within(panel).queryByLabelText('Organization mode')).toBeNull();
  expect(within(panel).queryByRole('button', { name: /Organize this canvas|Check connections|Apply proposal|Approve all|Recheck|Refresh document profile|Check connection evidence|Run suggested steps|Dismiss|Undo|Analyze saved documents|Add a source/ })).toBeNull();
  expect(within(panel).queryByText('More tools')).toBeNull();
}

it('shows exactly the retained automatic actions without requesting work or approval', async () => {
  const fixture = await workspaceFixture();
  const { panel } = await mountPanel(fixture);
  expectAutomaticOnly(panel);
  expect(within(panel).getByText('Waiting for a TypeSafe API key in Settings.')).toBeTruthy();
  expect(within(panel).getAllByRole('spinbutton').map(item => item.getAttribute('aria-label'))).toEqual(jevActions.map(action => `${jevActionLabels[action]} confidence threshold`));
  expect(within(panel).queryByRole('region', { name: 'Document progress' })).toBeNull();
  expect(within(panel).getByRole('region', { name: 'Automatic organization status' })).toBeTruthy();
  expect(jevActions).toHaveLength(6);
  expect(fixture.calls.filter(call => call.method !== 'GET')).toEqual([]);
  expect(await fixture.reload()).toEqual(fixture.canvas);
  expect(within(panel).queryByRole('button', { name: 'Settings' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Symbi settings' }));
  await within(panel).findByLabelText('TypeSafe API key');
  expect(within(panel).queryByRole('heading', { name: 'Symbi Reflex is active' })).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: 'Back to thresholds' }));
  await within(panel).findByRole('heading', { name: 'Symbi Reflex is active' });
  fireEvent.click(screen.getByRole('button', { name: 'Clear selected canvas' }));
  expect(screen.getByText('Select a canvas to open workspace organization.')).toBeTruthy();
});

it('automatically shows native progress and saved findings after a provider key is available', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(done => { release = done; });
  releases.push(release);
  const fixture = await workspaceFixture({ fetcher: async (input, init) => { await blocked; return acceptanceReflexProvider(input, init); } });
  await fixture.store.deleteWorkspace('acme-team');
  await api('/settings', { method: 'PUT', body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: 'automatic-panel-key' } }) });
  await waitFor(async () => {
    const state = await api<JevWorkspaceState>(`/workspaces/${fixture.workspace.id}/jev/state`);
    expect(state.jobs.some(job => ['queued', 'running'].includes(job.state))).toBe(true);
  }, { timeout: 2000 });
  const { panel } = await mountPanel(fixture);
  await waitFor(() => expect(within(panel).getByRole('region', { name: 'Automatic organization status' }).textContent).toContain('automatic checks in progress'));
  expectAutomaticOnly(panel);
  await act(async () => release());
  const files = new JevWorkspaceFiles(fixture.root);
  await expect.poll(async () => {
    const state = await files.read(fixture.workspace.id);
    return state.jobs.some(job => job.request.action === 'profile' && job.state === 'completed')
      && state.receipts.some(receipt => receipt.automatic);
  }, { timeout: 3000 }).toBe(true);
  await within(panel).findByText(/Saved activity ·/);
  expect(fixture.calls.filter(call => /\/jev\/(actions|commands)$/.test(call.route))).toEqual([]);
  const stored = await new JevWorkspaceFiles(fixture.root).read(fixture.workspace.id);
  expect(stored.settings.modes).toEqual(Object.fromEntries(jevActions.map(action => [action, 'auto'])));
  expect(stored.profiles[`${fixture.canvas.id}:${fixture.canvas.blocks[0].id}`]).toBeDefined();
});

it('keeps removed-action historical findings, profiles, connections and activity readable without new action controls', async () => {
  const fixture = await workspaceFixture();
  const first = fixture.canvas.blocks[0]; const second = fixture.canvas.blocks[1];
  const remoteCanvas = await fixture.store.createCanvas(fixture.workspace.id, { name: 'Release references' });
  const remoteGuide = await fixture.store.createBlock(remoteCanvas.id, { title: 'Remote guide', content: 'Release example.' });
  const remoteNote = await fixture.store.createBlock(remoteCanvas.id, { title: 'Remote note', content: 'Release reference.' });
  await fixture.store.updateBlock(fixture.canvas.id, first.id, { group: 'custom:release', tags: ['Release'], reviewer: 'release-owner',
    quality: { score: 0.9, at: '2026-10-04T12:00:00Z' }, links: [second.id], linkTypes: { [second.id]: 'prerequisite' },
    crossLinks: [{ canvasId: remoteCanvas.id, blockId: remoteGuide.id, relation: 'example_of' }, { canvasId: remoteCanvas.id, blockId: remoteNote.id }] }, 'Browser');
  const canvas = await fixture.reload(); const source = sourceSnapshot(fixture.workspace.id, canvas.id, canvas.blocks[0]);
  const files = new JevWorkspaceFiles(fixture.root); const state = await files.read(fixture.workspace.id);
  const proposal: JevProposal = { id: 'automatic-conflict', jobId: 'automatic-check', action: 'flag_conflict', title: 'Conflicting release claims',
    explanation: 'These saved sources give different release requirements.', state: 'applied', createdAt: '2026-10-04T12:00:00Z', sources: [source],
    evidence: [{ source, start: 0, end: 15, quote: '# Release guide' }], mutation: { kind: 'derived', blockId: first.id, values: { contradiction: true } } };
  state.proposals.push(proposal, { ...proposal, id: 'held-group', action: 'file', title: 'Grouping unchanged', state: 'pending', automaticHoldReason: 'Existing manual group is protected.' });
  state.receipts.push({ id: 'saved-conflict', proposalId: proposal.id, action: proposal.action, automatic: true, actor: 'automation',
    createdAt: proposal.createdAt, state: 'applied', before: { kind: 'derived', blockId: first.id, values: {} }, after: proposal.mutation, sourcesAfter: [source] });
  state.jobs.push({ id: proposal.jobId, request: { action: proposal.action, canvasId: canvas.id }, state: 'completed', sources: [source],
    createdAt: proposal.createdAt, updatedAt: proposal.createdAt, proposalIds: [proposal.id] }, {
    id: 'failed-quality', request: { action: 'score_quality', canvasId: canvas.id }, state: 'failed', sources: [source],
    createdAt: proposal.createdAt, updatedAt: proposal.createdAt, proposalIds: [], error: 'Provider is temporarily unavailable; automatic checks will resume.' });
  state.profiles[`${canvas.id}:${first.id}`] = { role: 'instructions', roleConfidence: 0.94, addressesAi: true, addressesAiConfidence: 0.93,
    entities: ['Release team'], keyPassages: ['Read the deployment checklist.'], organizationKey: 'internal-key',
    qualityRubric: { specificity: { score: 3, confidence: 0.95 }, traceability: { status: 'insufficient_evidence' } },
    recall: { evidenceStatus: 'no_verified_support', passages: [] } };
  await files.write(fixture.workspace.id, state);
  let opened = ''; const { panel } = await mountPanel(fixture, value => { opened = value; });
  expectAutomaticOnly(panel);
  const findings = within(panel).getByRole('region', { name: 'Automatic findings' });
  expect(within(findings).getByText('Find conflicting claims · Saved automatically')).toBeTruthy();
  expect(within(findings).getByText('Organize into groups · Not saved')).toBeTruthy();
  expect(within(findings).getByText('Existing manual group is protected.')).toBeTruthy();
  const conflict = within(findings).getByText('Conflicting release claims').closest('article')!;
  await toggleDetails(conflict, 'Finding details and source evidence');
  fireEvent.click(within(conflict).getByRole('button', { name: 'Open source passage' })); expect(opened).toBe('# Release guide');
  await toggleDetails(panel, 'Saved activity · 1 results');
  expect(within(panel).getByRole('alert').textContent).toContain('automatic checks will resume');
  await toggleDetails(panel, 'View saved result');
  fireEvent.click(within(panel).getByRole('button', { name: 'Show on canvas' })); expect(opened).toBe(`${canvas.id}:${first.id}`);
  await toggleDetails(panel, 'Document profiles and connections');
  await toggleDetails(panel, 'Release guide');
  expect(within(panel).getByText('Reviewer: release-owner')).toBeTruthy();
  expect(within(panel).getByText('Quality: 0.9')).toBeTruthy();
  expect(within(panel).getByText('instructions')).toBeTruthy();
  expect(within(panel).getByText('Role Confidence')).toBeTruthy(); expect(within(panel).getByText('0.94')).toBeTruthy();
  expect(within(panel).getByText('Addresses Ai')).toBeTruthy(); expect(within(panel).getByText('Addresses Ai Confidence')).toBeTruthy();
  expect(within(panel).getByText('0.93')).toBeTruthy(); expect(within(panel).getByText('Quality Rubric')).toBeTruthy();
  expect(within(panel).getByText('Specificity')).toBeTruthy(); expect(within(panel).getByText('insufficient evidence')).toBeTruthy();
  expect(within(panel).getByText('Recall')).toBeTruthy(); expect(within(panel).getByText('no verified support')).toBeTruthy();
  expect(within(panel).queryByText('internal-key')).toBeNull();
  const documentProfile = within(panel).getByText('Release guide', { selector: 'summary' }).closest('details')!;
  fireEvent.click(within(documentProfile).getByRole('button', { name: 'Read document' })); expect(opened).toBe(`${canvas.id}:${first.id}`);
  await toggleDetails(documentProfile, 'Saved connections · 3');
  fireEvent.click(within(documentProfile).getByRole('button', { name: 'Deployment checklist' })); expect(opened).toBe(`${canvas.id}:${second.id}`);
  fireEvent.click(within(documentProfile).getByRole('button', { name: remoteGuide.id })); expect(opened).toBe(`${remoteCanvas.id}:${remoteGuide.id}`);
  fireEvent.click(within(documentProfile).getByRole('button', { name: remoteNote.id })); expect(opened).toBe(`${remoteCanvas.id}:${remoteNote.id}`);
  expect(fixture.calls.filter(call => call.method !== 'GET')).toEqual([]);
});

it('keeps compact results unmounted, shows full-read progress, and opens only the selected document facts', async () => {
  const fixture = await workspaceFixture();
  await api(`/workspaces/${fixture.workspace.id}/jev/state`);
  const first = fixture.canvas.blocks[0]; const second = fixture.canvas.blocks[1];
  const source = sourceSnapshot(fixture.workspace.id, fixture.canvas.id, first);
  const files = new JevWorkspaceFiles(fixture.root); const state = await files.read(fixture.workspace.id);
  state.profiles[`${fixture.canvas.id}:${first.id}`] = { role: 'instructions', keyPassages: [first.content.split('\n')[1]], qualityRubric: { specificity: { score: 3 } } };
  state.profiles[`${fixture.canvas.id}:${second.id}`] = { role: 'context', entities: ['Deployment team'] };
  state.proposals.push({ id: 'lazy-finding', jobId: 'lazy-check', action: 'flag_conflict', title: 'Saved release finding', explanation: 'Saved passage evidence.',
    createdAt: '2020-01-01T00:00:00Z', state: 'applied', sources: [source], evidence: [{ source, start: 0, end: 15, quote: '# Release guide' }],
    mutation: { kind: 'derived', blockId: first.id, values: { contradiction: true } } });
  await files.write(fixture.workspace.id, state);
  const { panel } = await mountPanel(fixture, undefined, false, false);
  expect(within(panel).getAllByRole('spinbutton')).toHaveLength(6);
  expect(within(panel).getByText('Document understanding: 2 of 2 documents have a supported role or key passage.')).toBeTruthy();
  expect(within(panel).queryByRole('region', { name: 'Automatic findings' })).toBeNull();
  expect(within(panel).queryByText('Document profiles and connections')).toBeNull();
  expect(panel.querySelector('.jev-facts')).toBeNull();
  expect(fixture.calls.filter(call => call.route.endsWith('/jev/state'))).toHaveLength(1);

  const full = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  await toggleDetails(panel, 'Automatic findings and saved results');
  expect((await full.response).url.endsWith('/jev/state')).toBe(true);
  expect(within(panel).getByText('Loading saved findings…')).toBeTruthy();
  expect(within(panel).queryByRole('region', { name: 'Automatic findings' })).toBeNull();
  await act(async () => { await full.release(); });
  await within(panel).findByText('Saved release finding');
  expect(within(panel).queryByText('Loading saved findings…')).toBeNull();
  expect(within(panel).queryByText('# Release guide')).toBeNull();
  expect(within(panel).queryByText(first.title, { selector: 'summary' })).toBeNull();
  expect(panel.querySelector('.jev-facts')).toBeNull();

  await toggleDetails(panel, 'Document profiles and connections');
  const firstDetails = within(panel).getByText(first.title, { selector: 'summary' }).closest('details')!;
  const secondDetails = within(panel).getByText(second.title, { selector: 'summary' }).closest('details')!;
  expect(firstDetails.querySelector('.jev-facts')).toBeNull(); expect(secondDetails.querySelector('.jev-facts')).toBeNull();
  const beforeDocumentExpansion = fixture.calls.length;
  await toggleDetails(panel, first.title);
  expect(within(firstDetails).getByText('Quality Rubric')).toBeTruthy();
  expect(within(firstDetails).getByText('instructions')).toBeTruthy();
  expect(secondDetails.querySelector('.jev-facts')).toBeNull();
  expect(fixture.calls).toHaveLength(beforeDocumentExpansion);
  fireEvent(firstDetails, new window.Event('toggle', { bubbles: true }));
  expect(within(panel).getByText('Automatic findings and saved results').closest('details')).toHaveProperty('open', true);
  await toggleDetails(panel, first.title);
  expect(firstDetails.querySelector('.jev-facts')).toBeNull();
  await toggleDetails(panel, 'Document profiles and connections');
  expect(within(panel).queryByText(first.title, { selector: 'summary' })).toBeNull();
  await toggleDetails(panel, 'Finding details and source evidence');
  expect(within(panel).getByText('# Release guide')).toBeTruthy();
  await toggleDetails(panel, 'Automatic findings and saved results');
  expect(within(panel).queryByRole('region', { name: 'Automatic findings' })).toBeNull();
  expect(panel.querySelector('.jev-facts')).toBeNull();
  await waitFor(() => expect(fixture.calls.filter(call => call.route.endsWith('/jev/state?summary=1'))).toHaveLength(2));
  expect(within(panel).getAllByRole('spinbutton')).toHaveLength(6);
  expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
});

it('keeps an empty canvas useful and recovers a failed native state read through read-only retry', async () => {
  const fixture = await workspaceFixture();
  for (const block of fixture.canvas.blocks) await fixture.store.deleteBlock(fixture.canvas.id, block.id);
  fixture.canvas = await fixture.reload();
  const held = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  render(<NativePanel fixture={fixture}/>);
  await held.response;
  await act(async () => held.fail('Workspace temporarily unavailable'));
  const panel = screen.getByRole('region', { name: 'Symbi Reflex organization' });
  await waitFor(() => expect(within(panel).getByRole('alert').textContent).toContain('Workspace temporarily unavailable'));
  fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
  await within(panel).findByRole('heading', { name: 'Symbi Reflex is active' });
  expect(within(panel).getByText('New saved documents will be organized automatically.')).toBeTruthy();
  expect(within(panel).queryByText('Document profiles and connections')).toBeNull();
  expect(within(panel).queryByText(/Saved activity/)).toBeNull();
  expectAutomaticOnly(panel);
  expect(fixture.calls.filter(call => call.method !== 'GET')).toEqual([]);
});

it('opens provider settings from an external settings request', async () => {
  const fixture = await workspaceFixture();
  render(<NativePanel fixture={fixture} settingsRequest={1}/>);
  const panel = screen.getByRole('region', { name: 'Symbi Reflex organization' });
  await within(panel).findByLabelText('TypeSafe API key');
  expect(within(panel).getByRole('button', { name: 'Back to thresholds' })).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Back to thresholds' }));
  await within(panel).findByRole('heading', { name: 'Symbi Reflex is active' });
});

it('reports connection and pause settings with native readback and resumes watching an empty canvas', async () => {
  const fixture = await workspaceFixture({ fetcher: acceptanceReflexProvider });
  for (const block of fixture.canvas.blocks) await fixture.store.deleteBlock(fixture.canvas.id, block.id);
  const view = await mountPanel(fixture); const { panel } = view;
  fireEvent.click(screen.getByRole('button', { name: 'Symbi settings' }));
  fireEvent.change(within(panel).getByLabelText('TypeSafe API key'), { target: { value: 'automatic-panel-connection' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Connect TypeSafe' }));
  await waitFor(() => expect(within(panel).getAllByText('TypeSafe connection verified. No documents were sent.').length).toBeGreaterThan(0));
  fireEvent.click(within(panel).getByRole('button', { name: 'Back to thresholds' }));
  expect(within(panel).getByText('Watching saved documents for changes.')).toBeTruthy();
  expect(within(panel).getByText('TypeSafe connection verified. No documents were sent.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Symbi settings' }));
  fireEvent.click(within(panel).getByRole('checkbox', { name: 'Pause automatic work' }));
  await waitFor(async () => expect((await api<JevWorkspaceState>(`/workspaces/${fixture.workspace.id}/jev/state`)).settings.paused).toBe(true));
  await waitFor(() => expect(within(panel).getByText('Workspace settings updated.')).toBeTruthy());
  fireEvent.click(within(panel).getByRole('button', { name: 'Back to thresholds' }));
  expect(within(panel).getByText('Automatic processing is paused.')).toBeTruthy();
  view.unmount();
  await api(`/workspaces/${fixture.workspace.id}/jev/settings`, { method: 'PUT', body: JSON.stringify({ paused: false, externalProcessing: false }) });
  const unavailable = await mountPanel(fixture);
  expect(within(unavailable.panel).getByText('Automatic processing is unavailable in this workspace.')).toBeTruthy();
  expectAutomaticOnly(unavailable.panel);
});

it('opens a saved connection when its target is outside the currently supplied document view', async () => {
  const fixture = await workspaceFixture(); const first = fixture.canvas.blocks[0]; const second = fixture.canvas.blocks[1];
  await fixture.store.updateBlock(fixture.canvas.id, first.id, { links: [second.id] }, 'Browser');
  let opened = ''; const { panel } = await mountPanel(fixture, value => { opened = value; }, true);
  await toggleDetails(panel, 'Document profiles and connections');
  await toggleDetails(panel, 'Release guide');
  await toggleDetails(panel, 'Saved connections · 1');
  fireEvent.click(within(panel).getByRole('button', { name: 'Unavailable document' }));
  expect(opened).toBe(`${fixture.canvas.id}:${second.id}`);
  expectAutomaticOnly(panel);
  expect(fixture.calls.filter(call => call.method !== 'GET')).toEqual([]);
});

it.each([
  ['insufficient_group_evidence', 'No groups saved yet: the latest check could not verify a suitable group from the document passages.'],
  ['insufficient_local_group_purpose', 'No groups saved yet: the latest check could not verify a shared document purpose.'],
  ['no_source_derived_group_names', 'No groups saved yet: the latest check could not find a reusable topic in the document passages.'],
  ['no_change', 'Grouping checked: no supported change was needed.'],
])('explains a completed automatic grouping outcome %s without implying document understanding succeeded', async (status, message) => {
  const fixture = await workspaceFixture({ fetcher: acceptanceReflexProvider });
  await api(`/workspaces/${fixture.workspace.id}/jev/state`);
  vi.stubEnv('TYPESAFE_API_KEY', 'native-outcome-key');
  const files = new JevWorkspaceFiles(fixture.root); const state = await files.read(fixture.workspace.id);
  const createdAt = '2020-01-01T00:00:00Z';
  state.jobs.push({ id: 'grouping-outcome', request: { action: 'file', canvasId: fixture.canvas.id }, state: 'completed', sources: [], createdAt, updatedAt: createdAt, proposalIds: [], result: { status } },
    { id: 'label-outcome', request: { action: 'label', canvasId: fixture.canvas.id }, state: 'completed', sources: [], createdAt, updatedAt: createdAt, proposalIds: [], result: { status: 'missing_label_vocabulary' } });
  state.profiles[`${fixture.canvas.id}:${fixture.canvas.blocks[0].id}`] = { role: 'unknown', keyPassages: [], entities: [] };
  state.profiles[`${fixture.canvas.id}:${fixture.canvas.blocks[1].id}`] = { role: 'unknown', keyPassages: ['Follow the deployment checklist.'], entities: [] };
  await files.write(fixture.workspace.id, state);
  const { panel } = await mountPanel(fixture);
  expect(within(panel).getByText('Watching saved documents for changes.')).toBeTruthy();
  expect(within(panel).getByText(message)).toBeTruthy();
  expect(within(panel).getByText('No labels saved yet: the latest check had no reusable label vocabulary.')).toBeTruthy();
  expect(within(panel).getByText('Document understanding: 1 of 2 documents have a supported role or key passage.')).toBeTruthy();
  expectAutomaticOnly(panel); expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
});

it('shows the latest outcome without reporting earlier rejection as a current success or treating unknown profiles as understanding', async () => {
  const fixture = await workspaceFixture({ fetcher: acceptanceReflexProvider });
  await api(`/workspaces/${fixture.workspace.id}/jev/state`);
  vi.stubEnv('TYPESAFE_API_KEY', 'native-outcome-key');
  const files = new JevWorkspaceFiles(fixture.root); const state = await files.read(fixture.workspace.id);
  const createdAt = '2020-01-01T00:00:00Z';
  state.jobs.push({ id: 'latest-grouping-check', request: { action: 'file', canvasId: fixture.canvas.id }, state: 'failed', sources: [], createdAt, updatedAt: '2021-01-01T00:00:00Z', proposalIds: [], error: 'Grouping provider unavailable.' },
    { id: 'latest-label-check', request: { action: 'label', canvasId: fixture.canvas.id }, state: 'completed', sources: [], createdAt, updatedAt: createdAt, proposalIds: [] },
    { id: 'old-grouping-check', request: { action: 'file', canvasId: fixture.canvas.id }, state: 'completed', sources: [], createdAt, updatedAt: createdAt, proposalIds: [], result: { status: 'insufficient_group_evidence' } });
  state.profiles[`${fixture.canvas.id}:${fixture.canvas.blocks[0].id}`] = { role: 0, keyPassages: false };
  state.profiles[`${fixture.canvas.id}:${fixture.canvas.blocks[1].id}`] = { role: 'none', keyPassages: [] };
  await files.write(fixture.workspace.id, state);
  const { panel } = await mountPanel(fixture);
  expect(within(panel).getByText('Document understanding: 0 of 2 documents have a supported role or key passage.')).toBeTruthy();
  expect(within(panel).queryByText(/No groups saved yet|No labels saved yet|Grouping checked/)).toBeNull();
  await toggleDetails(panel, 'Saved activity · 0 results');
  expect(within(panel).getByRole('alert').textContent).toBe('Grouping provider unavailable.');
  expectAutomaticOnly(panel); expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
});

it('names Reflex automation and preserves named historical actors with saved timestamps', async () => {
  const fixture = await workspaceFixture();
  const files = new JevWorkspaceFiles(fixture.root); const state = await files.read(fixture.workspace.id);
  const source = sourceSnapshot(fixture.workspace.id, fixture.canvas.id, fixture.canvas.blocks[0]);
  const createdAt = '2026-10-07T10:30:00Z';
  const mutation = { kind: 'document' as const, canvasId: fixture.canvas.id, blockId: source.blockId, patch: { tags: ['Release'] } };
  for (const [id, actor, automatic] of [['historical-agent', 'Claude Code', false], ['automatic-reflex', 'jev-workspace-automation', true]] as const) {
    state.proposals.push({ id, jobId: `job-${id}`, action: 'label', title: `Saved ${id}`, explanation: 'Saved source organization',
      state: 'applied', createdAt, sources: [source], evidence: [], mutation });
    state.receipts.push({ id: `receipt-${id}`, proposalId: id, action: 'label', actor, automatic, createdAt,
      sourcesAfter: [source], state: 'applied', before: mutation, after: mutation });
  }
  await files.write(fixture.workspace.id, state);
  const { panel } = await mountPanel(fixture);
  await toggleDetails(panel, 'Saved activity · 2 results');
  expect(within(panel).getByText('Reflex', { exact: true }).getAttribute('title')).toBe('jev-workspace-automation');
  expect(within(panel).getByText('Claude Code', { exact: true }).getAttribute('title')).toBe('Claude Code');
  const times = Array.from(panel.querySelectorAll('.jev-saved-attribution time'));
  expect(times).toHaveLength(2);
  expect(times.map(time => [time.getAttribute('datetime'), time.textContent]))
    .toEqual([[createdAt, new Date(createdAt).toLocaleString()], [createdAt, new Date(createdAt).toLocaleString()]]);
  expect((await files.read(fixture.workspace.id)).receipts).toEqual(state.receipts);
  expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
});
