// @vitest-environment jsdom
import { readFile, writeFile } from 'node:fs/promises';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { assistantFixture, installAssistantBrowser, jsonBody, type Network } from './AppAssistantPanel.test.helpers';
import { acceptanceReflexProvider } from '../features/acceptance-reflex-provider';
import { CanvasStore } from '../server/storage';
import { JevWorkspaceFiles } from '../server/jev/workspace';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { JevWorkspaceState } from '../shared/jev-types';

installAssistantBrowser();

let fixture: Awaited<ReturnType<typeof assistantFixture>>;
let original: CanvasBlock;
let workspaceId: string;
let releaseProvider: () => void;
let providerCalls: number;
let stateGate: { arrived: (response: Response) => void; wait: Promise<Response> } | undefined;
const calls: Array<{ route: string; method: string; status: number }> = [];

const network: Network = async (route, init, forward) => {
  const gate = route.endsWith('/jev/state') && !init.method ? stateGate : undefined;
  if (gate) stateGate = undefined;
  const response = await forward();
  calls.push({ route, method: init.method ?? 'GET', status: response.status });
  if (!gate) return response;
  gate.arrived(response.clone());
  return gate.wait;
};

function holdState() {
  let arrived!: (response: Response) => void; let release!: (response: Response) => void;
  const response = new Promise<Response>(done => { arrived = done; });
  const wait = new Promise<Response>(done => { release = done; });
  stateGate = { arrived, wait };
  return { response, async release() { release(await response); } };
}

async function toggleDetails(scope: HTMLElement, title: string) {
  fireEvent.click(within(scope).getByText(title, { selector: 'summary' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  providerCalls = 0; calls.length = 0; stateGate = undefined;
  const providerHeld = new Promise<void>(done => { releaseProvider = done; });
  fixture = await assistantFixture(network, false, async (request, root) => {
    const store = new CanvasStore(root);
    const canvas = await store.getCanvas('product-roadmap'); workspaceId = canvas.workspaceId;
    for (const workspace of await store.listWorkspaces()) {
      for (const summary of workspace.canvases) if (summary.id !== canvas.id) await store.deleteCanvas(summary.id);
    }
    for (const block of canvas.blocks) await store.deleteBlock(canvas.id, block.id);
    original = await store.createBlock(canvas.id, { title: 'Release checklist', content: '# Release operations\nRelease operations require reviewing the deployment checklist before releasing the service.' });
    const ready = await request(`/api/workspaces/${workspaceId}/jev/settings`, { ...jsonBody({}), method: 'PUT' });
    expect(ready.ok).toBe(true);
  }, { fetcher: async (input, init) => { providerCalls++; await providerHeld; return acceptanceReflexProvider(input, init); } });
});
afterEach(() => { releaseProvider(); });

function openReflex() {
  fireEvent.click(screen.getByRole('tab', { name: 'Symbi Reflex' }));
  return screen.getByRole('region', { name: 'Symbi Reflex organization' });
}

it('keeps the mounted assistant resting while its initial native workspace read is held, then displays the saved state', async () => {
  const held = holdState(); const panel = openReflex();
  expect(within(panel).getByText('Opening workspace organization…')).toBeTruthy();
  expect(within(panel).getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('img', { name: 'Symbi Reflex resting' })).toBeTruthy();
  expect((await held.response).status).toBe(200);
  await act(async () => { await held.release(); });
  await within(panel).findByRole('heading', { name: 'Symbi Reflex is active' });
  expect(within(panel).queryByText('Opening workspace organization…')).toBeNull();
  expect(within(panel).getByText('Waiting for a TypeSafe API key in Settings.')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Symbi Reflex resting' })).toBeTruthy();
  expect((await fixture.read('product-roadmap')).blocks[0].content).toBe(original.content);
});

it('refreshes the full App after a real automatic FILE commit and shows the new group without rewriting the source', async () => {
  const panel = openReflex();
  await within(panel).findByRole('heading', { name: 'Symbi Reflex is active' });
  await toggleDetails(panel, 'Automatic findings and saved results');
  await within(panel).findByText('Document profiles and connections');
  await toggleDetails(panel, 'Document profiles and connections');
  await toggleDetails(panel, original.title);
  expect(within(panel).getByText('Group: Ungrouped · Labels: None')).toBeTruthy();
  const started = await fixture.request('/api/settings', { ...jsonBody({ secrets: { TYPESAFE_API_KEY: 'native-assistant-refresh-key' } }), method: 'PUT' });
  expect(started.ok).toBe(true);
  await waitFor(() => expect(providerCalls).toBeGreaterThan(0));
  const beforeCommit = calls.filter(call => call.route === '/api/canvases/product-roadmap').length;
  await act(async () => { releaseProvider(); });
  await within(panel).findByText(/^Group: Release operations · Labels:/, {}, { timeout: 3500 });
  expect(await screen.findByLabelText('Release operations group, 1 documents')).toBeTruthy();
  expect(calls.filter(call => call.route === '/api/canvases/product-roadmap').length).toBeGreaterThan(beforeCommit);
  const state = await fixture.request(`/api/workspaces/${workspaceId}/jev/state`).then(response => response.json()) as JevWorkspaceState;
  expect(state.receipts).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'file', automatic: true, state: 'applied', after: expect.objectContaining({ kind: 'document', patch: { group: 'custom:release_operations' } }) })]));
  expect(calls.some(call => /\/jev\/(actions|commands)$/.test(call.route))).toBe(false);
  const saved = await fixture.read('product-roadmap');
  expect(saved.blocks[0]).toMatchObject({ id: original.id, group: 'custom:release_operations', content: original.content, contentHash: original.contentHash, sourceGeneration: original.sourceGeneration });
  expect((await new CanvasStore(fixture.root).getCanvas('product-roadmap') as CanvasDocument).blocks[0].content).toBe(original.content);
});

it('shows unavailable after an actual native HTTP 503 and recovers through the visible read-only Retry control', async () => {
  const panel = openReflex();
  await within(panel).findByRole('heading', { name: 'Symbi Reflex is active' });
  const files = new JevWorkspaceFiles(fixture.root); const file = files.file(workspaceId);
  const saved = await readFile(file, 'utf8');
  await writeFile(file, '{interrupted workspace write');
  await waitFor(() => expect(calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ route: `/api/workspaces/${workspaceId}/jev/state`, method: 'GET', status: 503 }),
  ])), { timeout: 4000 });
  const retry = await within(panel).findByRole('button', { name: 'Retry' });
  expect(retry.parentElement?.textContent).toContain('Symbi Reflex workspace state requires recovery');
  expect(screen.getByRole('img', { name: 'Symbi Reflex unavailable' })).toBeTruthy();
  expect(screen.getByText('Connection unavailable')).toBeTruthy();
  await writeFile(file, saved);
  fireEvent.click(retry);
  await waitFor(() => expect(within(panel).queryByRole('alert')).toBeNull());
  expect(screen.getByRole('img', { name: 'Symbi Reflex resting' })).toBeTruthy();
  expect(within(panel).getByRole('heading', { name: 'Symbi Reflex is active' })).toBeTruthy();
  expect((await files.read(workspaceId)).settings).toEqual((JSON.parse(saved) as JevWorkspaceState).settings);
  expect(calls.filter(call => call.route.includes('/jev/')).every(call => call.method === 'GET')).toBe(true);
  expect((await fixture.read('product-roadmap')).blocks[0].content).toBe(original.content);
}, 8000);
