// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import type { ChatSettings } from '../shared/types';
import { api } from './api';
import { SettingsPage, type SettingsPayload } from './SettingsPage';

const nativeFetch = globalThis.fetch;
const opened: Array<{ server: Server; root: string }> = [];
type Intercept = (route: string, init?: RequestInit) => Response | Promise<Response> | undefined;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const model = (name: string) => Response.json([{ id: name.toLowerCase(), name }]);

async function fixture(patch: Partial<ChatSettings> = {}, initialIntercept?: Intercept) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-settings-page-'));
  const store = new CanvasStore(root); await store.init();
  await store.updateSettings({ model: 'fixture-model', providerKeys: { openrouter: 'fixture-router', openai: 'fixture-openai', anthropic: 'fixture-anthropic' } });
  const server = await createApiServer({ dataDir: root });
  opened.push({ server, root }); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test address');
  const base = `http://127.0.0.1:${address.port}`;
  let intercept = initialIntercept;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = String(input);
    return intercept?.(route, init) ?? nativeFetch(route.startsWith('/api/') ? base + route : input, init);
  }));
  const settings = { ...await api<ChatSettings>('/settings'), ...patch };
  const onSave = vi.fn(async (payload: SettingsPayload) => { await api('/settings', { method: 'PUT', body: JSON.stringify(payload) }); });
  const onCancel = vi.fn();
  const view = render(<SettingsPage settings={settings} busy={false} onSave={onSave} onCancel={onCancel} onSettings={vi.fn()}/>);
  await screen.findByText('Status available');
  return { ...view, settings, onSave, onCancel, store, intercept: (next?: Intercept) => { intercept = next; },
    readback: () => new CanvasStore(root).secretSettings() };
}
function addProfile(name: string, instructions = 'Explain evidence.') {
  fireEvent.change(screen.getByLabelText('New profile name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('New profile instructions'), { target: { value: instructions } });
  fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
}
function serverDraft(name = 'Service', url = 'https://mcp.example.com') {
  fireEvent.change(screen.getByLabelText('MCP server name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('MCP server URL'), { target: { value: url } });
}
const servers = () => screen.getByRole('region', { name: 'External tools Symbi can use' });
const draftTest = () => within(servers()).getAllByRole('button', { name: 'Test' }).at(-1)!;

beforeEach(() => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', ''); vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('settings page request ownership and persisted forms', () => {
  it('refreshes the provider list after it has already been loaded', async () => {
    const current = await fixture(); let attempts = 0;
    current.intercept(route => route.startsWith('/api/models') ? model(++attempts === 1 ? 'First model' : 'New model') : undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Browse models' }));
    await screen.findByRole('option', { name: /First model/ });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    await screen.findByRole('option', { name: /New model/ }); expect(attempts).toBe(2);
  });

  it.each(['success', 'error'])('does not publish an old provider %s after switching and loading another provider', async outcome => {
    const current = await fixture(); const pending = deferred<Response>();
    current.intercept(route => route === '/api/models?provider=openrouter' ? pending.promise : route === '/api/models?provider=openai' ? model('OpenAI model') : undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Browse models' }));
    fireEvent.click(screen.getByRole('radio', { name: /GPT and o-series models/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    await screen.findByRole('option', { name: /OpenAI model/ });
    await act(async () => pending.resolve(outcome === 'success' ? model('Old router model') : Response.json({ error: 'Old router failed' }, { status: 503 })));
    expect(screen.queryByRole('option', { name: /Old router model/ })).toBeNull();
    expect(screen.queryByText('Old router failed')).toBeNull(); expect(screen.getByRole('option', { name: /OpenAI model/ })).toBeTruthy();
  });

  it('keeps similarly named profiles independently selectable and persists the selected second profile', async () => {
    const current = await fixture(); addProfile('Sales coach', 'First instructions.'); addProfile('Sales-coach', 'Second instructions.');
    const profile = screen.getByRole('combobox', { name: /Agent profile/ });
    const first = within(profile).getByRole('option', { name: 'Sales coach' }) as HTMLOptionElement;
    const second = within(profile).getByRole('option', { name: 'Sales-coach' }) as HTMLOptionElement;
    expect(second.value).not.toBe(first.value);
    fireEvent.change(profile, { target: { value: second.value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(current.onSave).toHaveBeenCalledOnce());
    await current.onSave.mock.results[0].value;
    const saved = await current.readback(); expect(saved.agentProfile).toBe(second.value);
    expect(saved.customProfiles?.find(item => item.id === saved.agentProfile)?.instructions).toBe('Second instructions.');
  });

  it('gives similarly named MCP servers separate test results and saved identities', async () => {
    const current = await fixture();
    current.intercept((route, init) => route === '/api/mcp/servers/test' ? Response.json({ tools: [{ name: JSON.parse(String(init?.body)).name }] }) : undefined);
    serverDraft('Service'); fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    serverDraft('Service!'); fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    const tests = within(servers()).getAllByRole('button', { name: 'Test' });
    fireEvent.click(tests[0]); await screen.findByText('Service');
    await waitFor(() => expect(within(servers()).getAllByText('Connected · 1 tools')).toHaveLength(1));
    fireEvent.click(tests[1]); await waitFor(() => expect(within(servers()).getAllByText('Connected · 1 tools')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(current.onSave).toHaveBeenCalledOnce());
    await current.onSave.mock.results[0].value;
    const payload = current.onSave.mock.calls[0][0];
    const saved = await current.readback();
    expect(new Set((payload.mcpServers as Array<{ id: string }>).map(server => server.id)).size).toBe(2);
    expect(saved.mcpServers?.map(server => server.id)).toEqual(['service', 'service-2']);
  });

  it('keeps the latest connection test result when an earlier test finishes later', async () => {
    const current = await fixture(); const pending = deferred<Response>(); let attempts = 0;
    current.intercept(route => route === '/api/mcp/servers/test' ? ++attempts === 1 ? pending.promise : Response.json({ tools: [{ name: 'latest_tool' }] }) : undefined);
    serverDraft(); fireEvent.click(draftTest()); fireEvent.click(draftTest());
    await screen.findByText('latest_tool');
    await act(async () => pending.resolve(Response.json({ error: 'Older connection failed' }, { status: 503 })));
    expect(screen.queryByText('Older connection failed')).toBeNull(); expect(screen.getByText('latest_tool')).toBeTruthy();
  });

  it('does not claim a changed draft URL has passed a previous connection test', async () => {
    const current = await fixture(); const pending = deferred<Response>();
    current.intercept(route => route === '/api/mcp/servers/test' ? pending.promise : undefined);
    serverDraft(); fireEvent.click(draftTest());
    serverDraft('Different service', 'https://different.example.com/mcp');
    await act(async () => pending.resolve(Response.json({ tools: [{ name: 'old_tool' }] })));
    expect(screen.queryByText('Connected · 1 tools')).toBeNull(); expect(screen.queryByText('old_tool')).toBeNull();
  });

  it('returns to a built-in profile after removing the selected custom profile and saves successfully', async () => {
    const current = await fixture(); addProfile('Temporary profile');
    const profile = screen.getByRole('combobox', { name: /Agent profile/ });
    fireEvent.change(profile, { target: { value: 'custom-temporary-profile' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Temporary profile' }));
    expect(profile).toHaveProperty('value', 'general');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(current.onSave).toHaveBeenCalledOnce()); await current.onSave.mock.results[0].value;
    expect((await current.readback()).agentProfile).toBe('general');
  });

  it.each([false, true])('shows model-list errors and permits retry with primitive parser failure=%s', async primitive => {
    const current = await fixture(); let attempts = 0;
    current.intercept(route => {
      if (!route.startsWith('/api/models')) return;
      if (++attempts > 1) return model('Recovered');
      if (!primitive) return Response.json({ error: 'Catalog unavailable' }, { status: 503 });
      const response = Response.json([]); response.json = () => Promise.reject('Malformed body'); return response;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browse models' }));
    expect((await screen.findByRole('alert')).textContent).toContain(primitive ? 'Could not load models.' : 'Catalog unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' })); await screen.findByRole('option', { name: /Recovered/ });
    fireEvent.change(screen.getByLabelText('Filter models'), { target: { value: 'no matching model' } });
    expect(screen.getByText('No models match.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'manual-model' } }); expect(screen.getByLabelText('Model')).toHaveProperty('value', 'manual-model');
  });

  it('does not start a duplicate model request while loading and ignores a response after unmount', async () => {
    const current = await fixture(); const pending = deferred<Response>(); let attempts = 0;
    current.intercept(route => route.startsWith('/api/models') ? (++attempts, pending.promise) : undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Browse models' }));
    expect(screen.getByText('Loading models…')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    expect(attempts).toBe(1); current.unmount(); await act(async () => pending.resolve(model('Late model')));
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('edits independent profile fields and supports names without Latin letters', async () => {
    const current = await fixture(); addProfile('日本語'); addProfile('Editor');
    fireEvent.change(screen.getByLabelText('Name for 日本語'), { target: { value: 'Local writer' } });
    fireEvent.change(screen.getByLabelText('Instructions for Local writer'), { target: { value: 'Write clearly.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(current.onSave).toHaveBeenCalledOnce()); await current.onSave.mock.results[0].value;
    expect((await current.readback()).customProfiles).toEqual([{ id: 'custom-profile', name: 'Local writer', instructions: 'Write clearly.' }]);
  });

  it('retains a selected custom profile while editing it and resets selection when it is removed beside another profile', async () => {
    const current = await fixture(); addProfile('First writer'); addProfile('Second writer');
    const selector = screen.getByRole('combobox', { name: /Agent profile/ });
    fireEvent.change(selector, { target: { value: 'custom-first-writer' } });
    fireEvent.change(screen.getByLabelText('Instructions for First writer'), { target: { value: 'Revised instructions.' } });
    expect(selector).toHaveProperty('value', 'custom-first-writer');
    fireEvent.click(screen.getByRole('button', { name: 'Remove First writer' }));
    expect(selector).toHaveProperty('value', 'general');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' })); await waitFor(() => expect(current.onSave).toHaveBeenCalledOnce()); await current.onSave.mock.results[0].value;
    expect((await current.readback()).customProfiles?.map(profile => profile.id)).toEqual(['custom-second-writer']);
  });

  it('adds and removes pending secrets and undoes removal of a saved secret before persisting', async () => {
    const current = await fixture({ secretNames: ['SAVED_TOKEN'] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove secret SAVED_TOKEN' })); await screen.findByText('Will be removed');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' })); expect(screen.getByText('Saved')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'draft_token' } }); fireEvent.change(screen.getByLabelText('Secret value'), { target: { value: 'temporary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' })); fireEvent.click(screen.getByRole('button', { name: 'Remove secret DRAFT_TOKEN' }));
    expect(screen.queryByText('DRAFT_TOKEN')).toBeNull();
    fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'new_token' } }); fireEvent.change(screen.getByLabelText('Secret value'), { target: { value: 'private-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(current.onSave).toHaveBeenCalledOnce()); await current.onSave.mock.results[0].value;
    expect((await current.readback()).secrets?.NEW_TOKEN).toBe('private-value');
  });

  it('saves a custom provider, credentials, prompt, and plugin choices through the API', async () => {
    const current = await fixture({ provider: undefined, baseUrl: undefined,
      agentProfile: undefined, customProfiles: undefined, agentPlugins: undefined, mcpServers: undefined, groupBy: undefined, secretNames: undefined });
    fireEvent.click(screen.getByRole('radio', { name: /OpenAI-compatible/ }));
    fireEvent.change(screen.getByLabelText(/^Base URL/), { target: { value: ' https://models.example.com/v1 ' } });
    fireEvent.change(screen.getByLabelText(/OpenAI-compatible API key/), { target: { value: ' private-custom ' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: ' custom-model ' } });
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Explain checked evidence.' } });
    const plugins = screen.getByRole('region', { name: 'Plugins & loaders' });
    const read = within(plugins).getByRole('checkbox', { name: /Outside MCP servers/ }); fireEvent.click(read); fireEvent.click(read);
    fireEvent.click(within(plugins).getByRole('checkbox', { name: /Outside MCP servers/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(current.onSave).toHaveBeenCalledOnce()); await current.onSave.mock.results[0].value;
    expect(await current.readback()).toMatchObject({ provider: 'custom', baseUrl: 'https://models.example.com/v1', model: 'custom-model',
      providerKeys: { custom: 'private-custom' }, systemPrompt: 'Explain checked evidence.' });
    expect((await current.readback()).agentPlugins).toEqual([]);
  });

  it('keeps saved servers independently enabled, removes a server, and renders tool descriptions', async () => {
    const current = await fixture({ mcpServers: [
      { id: 'first', name: 'First', url: 'https://first.example.com', enabled: true, bearerSecret: 'TOKEN' },
      { id: 'second', name: 'Second', url: 'https://second.example.com', enabled: false },
    ], secretNames: ['TOKEN'] });
    current.intercept(route => route === '/api/mcp/servers/test' ? Response.json({ tools: [{ name: 'described', description: 'Reads a document' }, { name: 'plain' }, { name: 'search', capabilities: ['search', 'read'] }] }) : undefined);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Second' }));
    fireEvent.click(within(servers()).getAllByRole('button', { name: 'Test' })[0]); await screen.findByText('described · Reads a document'); expect(screen.getByText('plain')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove First' })); fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(current.onSave).toHaveBeenCalledOnce()); await current.onSave.mock.results[0].value;
    expect((await current.readback()).mcpServers).toMatchObject([{ id: 'second', enabled: true }]);
  });

  it('assigns a usable identity to a server name without Latin letters', async () => {
    const current = await fixture(); serverDraft('日本語'); fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' })); await waitFor(() => expect(current.onSave).toHaveBeenCalledOnce()); await current.onSave.mock.results[0].value;
    expect((await current.readback()).mcpServers).toMatchObject([{ id: 'server', name: '日本語' }]);
  });

  it.each([false, true])('shows an external server test failure and permits retry with primitive failure=%s', async primitive => {
    const current = await fixture(); let attempts = 0;
    current.intercept(route => {
      if (route !== '/api/mcp/servers/test') return;
      if (++attempts > 1) return Response.json({ tools: [] });
      if (!primitive) return Response.json({ error: 'Connection refused' }, { status: 503 });
      const response = Response.json({}); response.json = () => Promise.reject('Invalid connection response'); return response;
    });
    serverDraft('', 'https://mcp.example.com'); fireEvent.click(draftTest());
    await screen.findByText(primitive ? 'Could not connect.' : 'Connection refused');
    fireEvent.click(draftTest()); await screen.findByText('Connected · 0 tools');
  });

  it('navigates providers with keyboard keys, handles absent sections and resize, and cancels a busy form', async () => {
    const current = await fixture(); const group = screen.getByRole('radiogroup', { name: 'Model provider' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    const router = screen.getByRole('radio', { name: /OpenRouter/ }); router.focus();
    fireEvent.keyDown(router, { key: 'x' }); fireEvent.keyDown(router, { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: /OpenAI-compatible/ })).toHaveProperty('ariaChecked', 'true');
    document.getElementById('settings-activity')?.remove(); fireEvent.click(screen.getByRole('button', { name: 'Agent activity' }));
    const scroller = document.querySelector<HTMLElement>('.settings-page__scroll')!;
    const modelsSection = document.getElementById('settings-models')!;
    modelsSection.remove(); fireEvent.scroll(scroller); fireEvent(window, new Event('resize')); scroller.prepend(modelsSection);
    current.rerender(<SettingsPage settings={current.settings} busy={true} onSave={current.onSave} onCancel={current.onCancel} onSettings={vi.fn()}/>);
    expect(screen.getByText('Saving Settings…')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(current.onCancel).toHaveBeenCalledOnce();
  });

  it('shows a primitive save rejection and keeps the edited form available', async () => {
    const current = await fixture(); current.onSave.mockImplementation(async () => { throw 'Unexpected host failure'; });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' })); await screen.findByText('Could not save Settings.');
    expect(screen.getByLabelText('Model')).toHaveProperty('value', 'fixture-model');
  });
});
