// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JevPanel } from './JevPanel';
import { JevReset } from './JevReset';
import { useJevWorkspace } from './useJevWorkspace';
import { api } from './api';
import { workspaceFixture, closeWorkspaceFixtures } from './native-workspace.test.fixture';
import { acceptanceReflexProvider } from '../features/acceptance-reflex-provider';
import { JevWorkspaceFiles } from '../server/jev/workspace';
import { automationPrincipal, currentPrincipal } from '../server/jev/authorization';
import { getJevRuntime } from '../server/jev/runtime';
import { jevActions } from '../shared/jev-types';
import { sourceSnapshot } from '../server/jev/stamps';
import type { JevViewState } from './jev-client-types';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { JevQuestion } from '../server/jev';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from '../server/jev/actions/question-state-pool.test.helpers';

type Fixture = Awaited<ReturnType<typeof workspaceFixture>>;
const releases: Array<() => void> = [];
beforeEach(() => { vi.stubEnv('TYPESAFE_API_KEY', ''); });
afterEach(async () => { releases.splice(0).forEach(release => release()); cleanup(); await closeWorkspaceFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function NativeReset({ fixture, scoped }: { fixture: Fixture; scoped?: JevViewState }) {
  const [canvas, setCanvas] = useState(fixture.canvas);
  const model = useJevWorkspace(fixture.workspace.id, true, async () => setCanvas(await fixture.reload()));
  if (scoped) return <JevReset model={{ ...model, state: scoped }}/>;
  return <JevPanel model={model} canvas={canvas} settingsRequest={0} onAddSource={() => undefined}
    onOpenDocument={() => undefined} onOpenEvidence={() => undefined} onShowCanvas={() => undefined}/>;
}
async function mount(fixture: Fixture) {
  const view = render(<NativeReset fixture={fixture}/>);
  await screen.findByRole('button', { name: 'Reset automatic organization' }); return view;
}
function resetButton() { return screen.getByRole('button', { name: 'Reset automatic organization' }) as HTMLButtonElement; }
async function connectedFixture() {
  const fixture = await workspaceFixture({ fetcher: async (url, options) => {
    const response = await acceptanceReflexProvider(url, options);
    const request = JSON.parse(String(options?.body)) as { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
    const questions = resolveSharedQuestionTexts(request.questions, request.state.questionTexts);
    const homeQuestions = Object.entries(questions).filter(([id]) => id.replace(/^(\d+__)+/, '') === 'canvas');
    if (!homeQuestions.length) return response;
    // These sources already have a home; the external decision provides no supported reason to move them.
    const payload = await response.json();
    for (const [id, question] of homeQuestions) {
      let state = request.state; let originalId = id; let indexed = /^(\d+)__(.+)$/.exec(originalId);
      while (indexed) { state = (state.questionSets as Record<string, unknown>[])[Number(indexed[1])]; originalId = indexed[2]; indexed = /^(\d+)__(.+)$/.exec(originalId); }
      const scoped = resolveSharedQuestionSources(state, request.state.sourceStates);
      expect(scoped.source).toBeDefined(); expect(question.type).toBe('choice');
      if (question.type !== 'choice') throw new Error('Home checks must keep their bounded canvas choices');
      payload.answers[id] = { type: 'choice', choice: 'none', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === 'none' ? 1 : 0])) };
    }
    return Response.json(payload);
  } });
  await api(`/workspaces/${fixture.workspace.id}/jev/state`);
  await fixture.store.deleteWorkspace('acme-team');
  await fixture.store.deleteBlock(fixture.canvas.id, fixture.canvas.blocks[1].id);
  await api(`/workspaces/${fixture.workspace.id}/jev/settings`, { method: 'PUT', body: JSON.stringify({ paused: true }) });
  await api('/settings', { method: 'PUT', body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: 'native-reset-ui-key' } }) });
  fixture.canvas = await fixture.reload(); return fixture;
}

it('keeps reset unavailable while loading, without a provider, or when external processing is disabled', async () => {
  const fixture = await workspaceFixture();
  const initial = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  const view = render(<NativeReset fixture={fixture}/>);
  expect(screen.queryByRole('button', { name: 'Reset automatic organization' })).toBeNull();
  await initial.response; await act(async () => { await initial.release(); });
  expect(resetButton().disabled).toBe(true);
  expect(screen.getByText('A connected TypeSafe key and automatic processing are required to reset and rerun Symbi Reflex.')).toBeTruthy();
  fireEvent.click(resetButton()); expect(fixture.calls.filter(call => call.route.endsWith('/jev/reset'))).toEqual([]);
  await api(`/workspaces/${fixture.workspace.id}/jev/settings`, { method: 'PUT', body: JSON.stringify({ externalProcessing: false }) });
  vi.stubEnv('TYPESAFE_API_KEY', 'native-disabled-reset-key');
  view.unmount(); await mount(fixture);
  expect(resetButton().disabled).toBe(true); expect(screen.getAllByRole('spinbutton')).toHaveLength(6);
  expect(fixture.calls.filter(call => call.route.endsWith('/jev/reset'))).toEqual([]);
});

describe('with a connected native workspace', () => {
let fixture: Fixture;
beforeEach(async () => { fixture = await connectedFixture(); });

describe('with manual knowledge and historical results across canvases', () => {
let files: JevWorkspaceFiles;
let oldJobs: Set<string>;
let source: CanvasBlock;
let remote: CanvasDocument;
let remoteBlock: CanvasBlock;
let view: Awaited<ReturnType<typeof mount>>;
beforeEach(async () => {
  const first = fixture.canvas.blocks[0];
  await fixture.store.updateBlock(fixture.canvas.id, first.id, { group: 'custom:manual', tags: ['Manual'], x: 321, y: 654, reviewer: 'Human reviewer' }, 'Browser');
  await api(`/workspaces/${fixture.workspace.id}/jev/settings`, { method: 'PUT', body: JSON.stringify({ paused: true, confidenceThresholds: { profile: 0.85 } }) });
  remote = await fixture.store.createCanvas(fixture.workspace.id, { name: 'Other workspace documents' });
  remoteBlock = await fixture.store.createBlock(remote.id, { title: 'Remote release', content: '# Remote release\nKeep the exact source.' });
  fixture.canvas = await fixture.reload(); source = fixture.canvas.blocks[0];
  files = new JevWorkspaceFiles(fixture.root); const before = await files.read(fixture.workspace.id);
  before.profiles[`${fixture.canvas.id}:${first.id}`] = { role: 'Old analysis marker' };
  before.profiles[`${remote.id}:${remoteBlock.id}`] = { role: 'Old remote analysis marker' };
  before.jobs.push({ id: 'previous-profile-job', request: { action: 'profile', canvasId: fixture.canvas.id, blockIds: [first.id] },
    state: 'completed', sources: [sourceSnapshot(fixture.workspace.id, fixture.canvas.id, source)],
    createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', proposalIds: [] });
  await files.write(fixture.workspace.id, before);
  oldJobs = new Set(before.jobs.map(job => job.id));
  view = await mount(fixture);
});

it('resets the workspace from Reflex, preserves manual sources and thresholds, and automatically reruns all six actions', async () => {
  expect(resetButton().disabled).toBe(false);
  expect(screen.getByText('Across this workspace, clears Symbi Reflex analysis and automatic organization, then runs all 6 actions. Manual changes and source content remain.')).toBeTruthy();
  const held = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/reset`, 'POST');
  fireEvent.click(resetButton());
  expect((screen.getByRole('button', { name: 'Resetting automatic organization…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByRole('spinbutton').every(input => input.hasAttribute('disabled'))).toBe(true);
  expect((await held.response).ok).toBe(true);
  await act(async () => { await held.release(); });
  await screen.findByText('Jev-generated results cleared. Automatic checks restarted across this workspace.');
  await waitFor(() => expect(resetButton().disabled).toBe(false));
  await waitFor(async () => {
    const state = await files.read(fixture.workspace.id);
    expect(state.jobs.filter(job => job.state === 'failed').map(job => [job.request.action, job.error])).toEqual([]);
    expect(state.jobs.some(job => oldJobs.has(job.id))).toBe(false);
    for (const canvasId of [fixture.canvas.id, remote.id]) {
      expect(new Set(state.jobs.filter(job => job.request.canvasId === canvasId).map(job => job.request.action))).toEqual(new Set(jevActions));
    }
    expect(state.jobs.filter(job => job.state !== 'completed').map(job => [job.request.action, job.state, job.error])).toEqual([]);
    expect(JSON.stringify(state.profiles)).not.toContain('Old analysis marker');
    expect(JSON.stringify(state.profiles)).not.toContain('Old remote analysis marker');
    expect(state.profiles[`${remote.id}:${remoteBlock.id}`]).toBeDefined();
    expect(state.settings.confidenceThresholds?.profile).toBe(0.85); expect(state.settings.paused).toBe(false);
  }, { timeout: 4000 });
  const saved = (await fixture.reload()).blocks.find(block => block.id === source.id)!;
  expect(saved).toMatchObject({ content: source.content, title: source.title,
    x: 321, y: 654, group: 'custom:manual', tags: ['Manual'], reviewer: 'Human reviewer', contentHash: source.contentHash,
    incarnation: source.incarnation, sourceGeneration: source.sourceGeneration });
  expect(saved.jevOwnership?.pins).toEqual(expect.arrayContaining(['group', 'tags', 'reviewer']));
  const savedRemote = (await fixture.reload(remote.id)).blocks[0];
  expect(savedRemote).toMatchObject({ content: remoteBlock.content, contentHash: remoteBlock.contentHash,
    incarnation: remoteBlock.incarnation, sourceGeneration: remoteBlock.sourceGeneration });
  const completed = await files.read(fixture.workspace.id);
  expect(completed.receipts.some(receipt => receipt.automatic && receipt.actor === automationPrincipal.id)).toBe(true);
  expect(completed.receipts.filter(receipt => receipt.automatic).every(receipt => receipt.sourcesAfter.every(snapshot =>
    snapshot.contentHash === (snapshot.blockId === source.id ? source.contentHash : remoteBlock.contentHash)))).toBe(true);
  expect((await api<JevViewState>(`/workspaces/${fixture.workspace.id}/jev/state`)).hasApiKey).toBe(true);
  const calls = fixture.calls.filter(call => call.route.endsWith('/jev/reset'));
  expect(calls).toEqual([{ route: `/api/workspaces/${fixture.workspace.id}/jev/reset`, method: 'POST', body: {} }]);
  view.unmount(); await mount(fixture);
  expect((screen.getByRole('spinbutton', { name: 'Understand documents confidence threshold' }) as HTMLInputElement).value).toBe('85');
});
});

it('reports a lost reset response and allows another reset without claiming the failed response succeeded', async () => {
  await mount(fixture);
  const files = new JevWorkspaceFiles(fixture.root); const source = fixture.canvas.blocks[0];
  const held = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/reset`, 'POST');
  fireEvent.click(resetButton()); await held.response;
  await act(async () => { held.fail('Reset response temporarily unavailable'); });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Reset response temporarily unavailable'));
  expect(screen.queryByText('Jev-generated results cleared. Automatic checks restarted across this workspace.')).toBeNull();
  expect(resetButton().disabled).toBe(false);
  await waitFor(async () => expect((await files.read(fixture.workspace.id)).receipts.some(receipt => receipt.automatic)).toBe(true));
  const firstReceipts = (await files.read(fixture.workspace.id)).receipts.map(receipt => receipt.id);
  fireEvent.click(resetButton());
  await screen.findByText('Jev-generated results cleared. Automatic checks restarted across this workspace.');
  expect(screen.queryByRole('alert')).toBeNull();
  expect((await files.read(fixture.workspace.id)).receipts.map(receipt => receipt.id)).toEqual(expect.arrayContaining(firstReceipts));
  expect((await fixture.reload()).blocks[0]).toMatchObject({ content: source.content, contentHash: source.contentHash,
    incarnation: source.incarnation, sourceGeneration: source.sourceGeneration });
  expect((await api<JevViewState>(`/workspaces/${fixture.workspace.id}/jev/state`)).hasApiKey).toBe(true);
});
});

it('hides the workspace reset for a scoped read principal', async () => {
  const fixture = await workspaceFixture();
  const credential = await fixture.store.createMcpToken('Read automatic results', 'read', { allowedCanvasIds: [fixture.canvas.id], tools: ['jev_activity'] });
  const identity = (await fixture.store.mcpTokenIdentity(credential.token))!;
  const principal = await currentPrincipal(fixture.store, { ...identity, kind: 'token' });
  const runtime = getJevRuntime(fixture.store, { startTimer: false });
  try {
    const scoped: JevViewState = { ...await runtime.read(fixture.workspace.id, principal), hasApiKey: false, canConfigure: Boolean(principal.canConfigure), canApprove: Boolean(principal.canApprove) };
    render(<NativeReset fixture={fixture} scoped={scoped}/>);
    expect(screen.queryByRole('region', { name: 'Reset automatic organization' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset automatic organization' })).toBeNull();
  } finally { await runtime.shutdown(); }
});
