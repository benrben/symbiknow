// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JevPanel } from './JevPanel';
import { JevThresholds } from './JevThresholds';
import { useJevWorkspace } from './useJevWorkspace';
import { api } from './api';
import { jevActions } from '../shared/jev-types';
import { jevActionLabels } from '../shared/jev-action-labels';
import { JevWorkspaceFiles } from '../server/jev/workspace';
import { workspaceFixture, closeWorkspaceFixtures } from './native-workspace.test.fixture';
import type { JevViewState } from './jev-client-types';
import { currentPrincipal } from '../server/jev/authorization';
import { getJevRuntime } from '../server/jev/runtime';

type Fixture = Awaited<ReturnType<typeof workspaceFixture>>;
beforeEach(() => { vi.stubEnv('TYPESAFE_API_KEY', ''); });
afterEach(async () => { cleanup(); await closeWorkspaceFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function NativeThresholds({ fixture, scoped }: { fixture: Fixture; scoped?: JevViewState }) {
  const model = useJevWorkspace(fixture.workspace.id);
  if (scoped) return <JevThresholds model={{ ...model, state: scoped }}/>;
  return <JevPanel model={model} canvas={fixture.canvas} settingsRequest={0} onAddSource={() => { throw new Error('Thresholds must not launch actions'); }}
    onOpenDocument={() => undefined} onOpenEvidence={() => undefined} onShowCanvas={() => undefined}/>;
}
function percent(label: string) { return screen.getByRole('spinbutton', { name: `${label} confidence threshold` }) as HTMLInputElement; }
async function mount(fixture: Fixture) {
  const view = render(<NativeThresholds fixture={fixture}/>);
  await screen.findByRole('spinbutton', { name: 'Understand documents confidence threshold' }); return view;
}

it('shows exactly six automatic confidence fields as the primary Reflex controls and saves percentages with native reload', async () => {
  const fixture = await workspaceFixture(); const files = new JevWorkspaceFiles(fixture.root);
  const initial = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/state`, 'GET');
  const view = render(<NativeThresholds fixture={fixture}/>);
  expect(screen.queryByRole('region', { name: 'Automatic action thresholds' })).toBeNull(); expect(screen.queryByRole('spinbutton')).toBeNull();
  await initial.response; await act(async () => { await initial.release(); });
  const thresholds = screen.getByRole('region', { name: 'Automatic action thresholds' });
  expect(within(thresholds).getAllByRole('row')).toHaveLength(7);
  for (const removed of ['Find conflicting claims', 'Recheck connections', 'Manage groups and labels', 'Review document quality', 'Connect documents to work', 'Suggest responsibility', 'Find supporting knowledge']) {
    expect(within(thresholds).queryByRole('spinbutton', { name: `${removed} confidence threshold` })).toBeNull();
  }
  expect(within(thresholds).getAllByRole('spinbutton').map(input => [input.getAttribute('aria-label'), (input as HTMLInputElement).value]))
    .toEqual(jevActions.map(action => [`${jevActionLabels[action]} confidence threshold`, '70']));
  expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', { name: /Apply|Run|Approve/ })).toBeNull();
  expect(within(thresholds).queryByRole('button')).toBeNull(); expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  expect(screen.getByText('Automatic findings and saved results').closest('details')?.open).toBe(false);
  const save = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/settings`, 'PUT');
  fireEvent.change(percent('Understand documents'), { target: { value: '85' } });
  expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
  fireEvent.blur(percent('Understand documents'));
  expect((await save.response).ok).toBe(true);
  expect(within(thresholds).getAllByRole('spinbutton').every(input => input.hasAttribute('disabled'))).toBe(true);
  expect((await files.read(fixture.workspace.id)).settings.confidenceThresholds?.profile).toBe(0.85);
  await act(async () => { await save.release(); });
  await waitFor(() => expect(percent('Understand documents').disabled).toBe(false));
  fireEvent.change(percent('Compare possible duplicates'), { target: { value: '90' } }); fireEvent.blur(percent('Compare possible duplicates'));
  expect(percent('Understand documents').value).toBe('85');
  await waitFor(async () => expect((await files.read(fixture.workspace.id)).settings.confidenceThresholds).toMatchObject({ profile: 0.85, flag_duplicate: 0.9 }));
  await waitFor(() => expect(percent('Compare possible duplicates').disabled).toBe(false));
  view.unmount(); await mount(fixture);
  expect(percent('Understand documents').value).toBe('85'); expect(percent('Compare possible duplicates').value).toBe('90');
  expect(percent('Suggest labels').value).toBe('70');
  expect(fixture.calls.filter(call => /\/jev\/(actions|commands|proposals)/.test(call.route))).toEqual([]);
  const state = await api<JevViewState>(`/workspaces/${fixture.workspace.id}/jev/state`);
  expect(jevActions.every(action => state.settings.modes[action] === 'auto')).toBe(true);
});

it('rejects empty and out-of-range percentages locally and accepts unchanged boundary values without a save button', async () => {
  const fixture = await workspaceFixture(); await mount(fixture);
  const field = percent('Suggest labels');
  for (const value of ['', '49', '101']) {
    fireEvent.change(field, { target: { value } }); fireEvent.blur(field);
    expect(screen.getByRole('alert').textContent).toBe('Use 50% to 100%.'); expect(field.getAttribute('aria-invalid')).toBe('true');
  }
  expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
  fireEvent.change(field, { target: { value: '70' } }); fireEvent.blur(field);
  expect(screen.queryByRole('alert')).toBeNull(); expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
  fireEvent.change(field, { target: { value: '50' } }); fireEvent.blur(field);
  await waitFor(() => expect(field.disabled).toBe(false));
  await waitFor(async () => expect((await new JevWorkspaceFiles(fixture.root).read(fixture.workspace.id)).settings.confidenceThresholds?.label).toBe(0.5));
  fireEvent.change(field, { target: { value: '100' } }); fireEvent.blur(field);
  await waitFor(async () => expect((await new JevWorkspaceFiles(fixture.root).read(fixture.workspace.id)).settings.confidenceThresholds?.label).toBe(1));
});

it('shows a lost save response, keeps the edited percentage, and can autosave a corrected threshold', async () => {
  const fixture = await workspaceFixture(); await mount(fixture);
  const save = fixture.hold(`/api/workspaces/${fixture.workspace.id}/jev/settings`, 'PUT');
  fireEvent.change(percent('Find useful connections'), { target: { value: '88.5' } }); fireEvent.blur(percent('Find useful connections'));
  await save.response; await act(async () => { save.fail('Threshold save response unavailable'); });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Threshold save response unavailable'));
  expect(percent('Find useful connections').value).toBe('88.5');
  expect((await new JevWorkspaceFiles(fixture.root).read(fixture.workspace.id)).settings.confidenceThresholds?.link).toBe(0.885);
  fireEvent.change(percent('Find useful connections'), { target: { value: '90' } }); fireEvent.blur(percent('Find useful connections'));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  await waitFor(async () => expect((await new JevWorkspaceFiles(fixture.root).read(fixture.workspace.id)).settings.confidenceThresholds?.link).toBe(0.9));
});

it('keeps threshold percentages read-only for an actual scoped agent principal', async () => {
  const fixture = await workspaceFixture();
  const credential = await fixture.store.createMcpToken('Read thresholds', 'read', { allowedCanvasIds: [fixture.canvas.id], tools: ['jev_activity'] });
  const identity = (await fixture.store.mcpTokenIdentity(credential.token))!;
  const principal = await currentPrincipal(fixture.store, { ...identity, kind: 'token' });
  const runtime = getJevRuntime(fixture.store, { startTimer: false });
  try {
    const native = await runtime.read(fixture.workspace.id, principal);
    // Older clients may omit this optional setting from a scoped read; the owner-only boundary still applies.
    const scoped: JevViewState = { ...native, settings: { ...native.settings, confidenceThresholds: undefined },
      hasApiKey: false, canConfigure: Boolean(principal.canConfigure), canApprove: Boolean(principal.canApprove) };
    render(<NativeThresholds fixture={fixture} scoped={scoped}/>);
    expect(screen.getByText('Only the workspace owner can change thresholds.')).toBeTruthy();
    expect(screen.getAllByRole('spinbutton').every(input => input.hasAttribute('disabled'))).toBe(true);
    expect(screen.getAllByRole('spinbutton').every(input => (input as HTMLInputElement).value === '70')).toBe(true);
  } finally { await runtime.shutdown(); }
});
