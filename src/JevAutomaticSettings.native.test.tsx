// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JevSettings } from './JevSettings';
import { useJevWorkspace } from './useJevWorkspace';
import { api } from './api';
import type { JevViewState } from './jev-client-types';
import { workspaceFixture, closeWorkspaceFixtures } from './native-workspace.test.fixture';
import { acceptanceReflexProvider } from '../features/acceptance-reflex-provider';
import { jevActions } from '../shared/jev-types';
import { currentPrincipal } from '../server/jev/authorization';
import { getJevRuntime } from '../server/jev/runtime';

type Fixture = Awaited<ReturnType<typeof workspaceFixture>>;
const nativeFetch = globalThis.fetch;
const releases: Array<() => void> = [];
beforeEach(() => { vi.stubEnv('TYPESAFE_API_KEY', ''); });
afterEach(async () => { releases.splice(0).forEach(release => release()); cleanup(); await closeWorkspaceFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function settingsFixture(fetcher = acceptanceReflexProvider) {
  const fixture = await workspaceFixture({ fetcher });
  await fixture.store.deleteWorkspace('acme-team');
  return fixture;
}
function NativeSettings({ fixture, scoped }: { fixture: Fixture; scoped?: JevViewState }) {
  const model = useJevWorkspace(fixture.workspace.id);
  return <><output aria-label="Settings load">{model.state ? 'ready' : 'loading'}</output>
    {model.error && <p role="alert">{model.error}</p>}{model.notice && <p role="status">{model.notice}</p>}
    <JevSettings model={scoped ? { ...model, state: scoped } : model} canvasId={fixture.canvas.id}/></>;
}
async function mountSettings(fixture: Fixture) {
  const held = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  const view = render(<NativeSettings fixture={fixture}/>);
  expect(screen.getByLabelText('Settings load').textContent).toBe('loading');
  expect(screen.queryByRole('heading', { name: 'Automatic knowledge organization' })).toBeNull();
  expect((await held.response).ok).toBe(true);
  await act(async () => { await held.release(); });
  await screen.findByRole('heading', { name: 'Automatic knowledge organization' });
  return view;
}
function currentState(fixture: Fixture) {
  return api<JevViewState>(`/workspaces/${fixture.workspace.id}/jev/state`);
}

it('saves a trimmed provider key, preserves active automatic profiles through redundant settings, and checks the connection without sending documents', async () => {
  let release!: () => void; const heldProvider = new Promise<void>(done => { release = done; }); releases.push(release);
  const provider = vi.fn<typeof fetch>(async (input, options) => { await heldProvider; return acceptanceReflexProvider(input, options); });
  const fixture = await settingsFixture(provider); await mountSettings(fixture);
  expect(screen.getByText('A TypeSafe API key is required for analysis. Work starts automatically when a key is available.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Connect TypeSafe' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('TypeSafe API key'), { target: { value: '   ' } });
  expect(screen.getByRole('button', { name: 'Connect TypeSafe' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('TypeSafe API key'), { target: { value: '  native-automatic-settings-key  ' } });
  const keySave = fixture.hold('/api/settings', 'PUT');
  const automaticConfig = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/settings`, 'PUT');
  fireEvent.click(screen.getByRole('button', { name: 'Connect TypeSafe' }));
  expect(screen.getByRole('button', { name: 'Connecting TypeSafe…' }).hasAttribute('disabled')).toBe(true);
  expect((await keySave.response).ok).toBe(true);
  await waitFor(async () => expect((await currentState(fixture)).jobs.some(job => job.request.action === 'profile' && job.state === 'running')).toBe(true));
  const active = (await currentState(fixture)).jobs.filter(job => job.request.action === 'profile' && ['queued', 'running'].includes(job.state)).map(job => job.id);
  await act(async () => { await keySave.release(); });
  expect((await automaticConfig.response).ok).toBe(true);
  const unchanged = await currentState(fixture);
  expect(active.length).toBeGreaterThan(0);
  expect(active.every(id => unchanged.jobs.some(job => job.id === id && ['queued', 'running'].includes(job.state)))).toBe(true);
  expect(unchanged.settings).toMatchObject({ externalProcessing: true, paused: false, modes: Object.fromEntries(jevActions.map(action => [action, 'auto'])) });
  expect(fixture.calls.find(call => call.route === '/api/settings' && call.method === 'PUT')?.body).toEqual({ secrets: { TYPESAFE_API_KEY: 'native-automatic-settings-key' } });
  await act(async () => { await automaticConfig.release(); });
  await screen.findByText('Your TypeSafe key is saved. No requests or approvals are needed.');
  expect((screen.getByLabelText('TypeSafe API key') as HTMLInputElement).value).toBe('');
  await act(async () => release());
  await waitFor(() => expect(screen.getAllByText('TypeSafe connection verified. No documents were sent.').length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Test TypeSafe connection' }).hasAttribute('disabled')).toBe(false));
  await waitFor(async () => expect((await currentState(fixture)).receipts.some(receipt => receipt.automatic && receipt.action === 'profile')).toBe(true));
  expect(fixture.calls.filter(call => /\/jev\/(actions|commands)$/.test(call.route))).toEqual([]);
  const probe = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/connection`, 'POST');
  fireEvent.click(screen.getByRole('button', { name: 'Test TypeSafe connection' }));
  expect(screen.getByRole('button', { name: 'Test TypeSafe connection' }).hasAttribute('disabled')).toBe(true);
  expect((await probe.response).ok).toBe(true); await act(async () => { await probe.release(); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Test TypeSafe connection' }).hasAttribute('disabled')).toBe(false));
  const probes = provider.mock.calls.map(call => JSON.parse(String(call[1]?.body))).filter(body => body.state?.connectionProbe);
  expect(probes).toHaveLength(2); expect(probes.every(body => JSON.stringify(body.state) === JSON.stringify({ connectionProbe: true }))).toBe(true);
});

it('keeps invalid key input available after a native save rejection and can save a corrected key', async () => {
  const fixture = await settingsFixture(); await mountSettings(fixture);
  const invalid = 'x'.repeat(8193);
  fireEvent.change(screen.getByLabelText('TypeSafe API key'), { target: { value: invalid } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect TypeSafe' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Secret TYPESAFE_API_KEY'));
  expect((screen.getByLabelText('TypeSafe API key') as HTMLInputElement).value).toBe(invalid);
  expect((await currentState(fixture)).hasApiKey).toBe(false);
  expect(screen.getByRole('button', { name: 'Connect TypeSafe' }).hasAttribute('disabled')).toBe(false);
  fireEvent.change(screen.getByLabelText('TypeSafe API key'), { target: { value: 'corrected-automatic-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect TypeSafe' }));
  await waitFor(() => expect(screen.getAllByText('TypeSafe connection verified. No documents were sent.').length).toBeGreaterThan(0));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('shows a rejected connection without claiming success and retains the saved key for correction', async () => {
  const fixture = await settingsFixture(async () => Response.json({ message: 'Rejected key' }, { status: 401 })); await mountSettings(fixture);
  fireEvent.change(screen.getByLabelText('TypeSafe API key'), { target: { value: 'rejected-provider-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect TypeSafe' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('rejected the API key'));
  expect(screen.queryByText('TypeSafe connection verified. No documents were sent.')).toBeNull();
  expect((await currentState(fixture)).hasApiKey).toBe(true);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Test TypeSafe connection' }).hasAttribute('disabled')).toBe(false));
});

it('trims optional known people, resets only successful saves, removes the selected person, and reads pause changes back', async () => {
  const fixture = await settingsFixture(); await mountSettings(fixture);
  fireEvent.click(screen.getByText('Known people'));
  expect(screen.getByRole('button', { name: 'Add known person' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Person name'), { target: { value: '  Morgan  ' } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: '  Reviewer  ' } });
  const add = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/settings`, 'PUT');
  fireEvent.click(screen.getByRole('button', { name: 'Add known person' }));
  expect(screen.getByRole('button', { name: 'Add known person' }).hasAttribute('disabled')).toBe(true);
  expect((await add.response).ok).toBe(true); await act(async () => { await add.release(); });
  await screen.findByText('Morgan · Reviewer');
  await waitFor(() => expect((screen.getByLabelText('Person name') as HTMLInputElement).value).toBe(''));
  expect((screen.getByLabelText('Role') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Person name'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Engineer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add known person' })); await screen.findByText('Ada · Engineer');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Morgan' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Remove Morgan' }));
  await waitFor(() => expect(screen.queryByText('Morgan · Reviewer')).toBeNull());
  await waitFor(async () => expect((await currentState(fixture)).settings.people).toEqual([expect.objectContaining({ name: 'Ada', role: 'Engineer' })]));
  fireEvent.change(screen.getByLabelText('Person name'), { target: { value: 'M'.repeat(121) } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Keep this role' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add known person' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Add known person' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Invalid known person'));
  expect((screen.getByLabelText('Person name') as HTMLInputElement).value).toBe('M'.repeat(121));
  expect((screen.getByLabelText('Role') as HTMLInputElement).value).toBe('Keep this role');
  expect((await currentState(fixture)).settings.people).toHaveLength(1);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Pause automatic work' }));
  await waitFor(async () => expect((await currentState(fixture)).settings.paused).toBe(true));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Pause automatic work' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Pause automatic work' }));
  await waitFor(async () => expect((await currentState(fixture)).settings.paused).toBe(false));
});

it('uses actual scoped permissions to hide owner settings and denies a direct settings write', async () => {
  const fixture = await settingsFixture();
  const credential = await fixture.store.createMcpToken('Read automatic organization', 'read', { allowedCanvasIds: [fixture.canvas.id], tools: ['jev_activity'] });
  const identity = (await fixture.store.mcpTokenIdentity(credential.token))!;
  const principal = await currentPrincipal(fixture.store, { ...identity, kind: 'token' });
  const runtime = getJevRuntime(fixture.store, { startTimer: false });
  let scoped!: JevViewState;
  try { scoped = { ...await runtime.read(fixture.workspace.id, principal), hasApiKey: false, canConfigure: Boolean(principal.canConfigure), canApprove: Boolean(principal.canApprove) }; }
  finally { await runtime.shutdown(); }
  render(<NativeSettings fixture={fixture} scoped={scoped}/>);
  expect(screen.getByText('Only the workspace owner can change connection settings.')).toBeTruthy();
  expect(screen.queryByLabelText('TypeSafe API key')).toBeNull();
  expect(screen.queryByText('Known people')).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Pause automatic work' })).toBeNull();
  const denied = await nativeFetch(`${fixture.baseUrl}/api/workspaces/${fixture.workspace.id}/jev/settings`, { method: 'PUT',
    headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }) });
  expect(denied.status).toBe(403);
  expect((await currentState(fixture)).settings.paused).toBe(false);
});
