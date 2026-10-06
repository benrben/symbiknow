// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApiServer } from '../server/index';
import { CanvasStore } from '../server/storage';
import type { CanvasDocument } from '../shared/types';
import { api } from './api';
import { VersionPanel } from './VersionPanel';
import type { VersionStatus } from './version-panel-types';

const nativeFetch = globalThis.fetch;
const opened: { server: Server; root: string }[] = [];
const canvasPath = '/canvases/product-roadmap';
const documentPath = canvasPath + '/blocks/roadmap-overview';
const versionsPath = documentPath + '/versions';

async function fixture() {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', ''); vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-version-panel-'));
  const server = await createApiServer({ dataDir: root }); opened.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
  const base = 'http://127.0.0.1:' + address.port;
  const network = { dropNextSave: false, writes: [] as string[] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const route = String(input); if (options?.method === 'POST' || options?.method === 'PUT') network.writes.push(route);
    const response = await nativeFetch(route.startsWith('/api/') ? base + route : input, options);
    if (network.dropNextSave && options?.method === 'POST' && route.endsWith('/switch')) {
      network.dropNextSave = false; await response.text(); throw new Error('Connection lost after the server saved');
    }
    return response;
  }));
  const original = await api<CanvasDocument>(canvasPath);
  const block = original.blocks.find(document => document.id === 'roadmap-overview')!;
  const readback = () => new CanvasStore(root).getCanvas('product-roadmap');
  const history = () => new CanvasStore(root).documentHistory('product-roadmap', block.id);
  const onChanged = vi.fn(async () => { await api<CanvasDocument>(canvasPath); });
  return { block, original, network, readback, history, onChanged };
}

async function prepareBranch(name: string, content: string, exists = false) {
  if (!exists) await api(versionsPath + '/branches', { method: 'POST', body: JSON.stringify({ name }) });
  await api(versionsPath + '/switch', { method: 'POST', body: JSON.stringify({ name }) });
  await api(documentPath, { method: 'PUT', body: JSON.stringify({ content }) });
  await api(versionsPath + '/switch', { method: 'POST', body: JSON.stringify({ name: 'main' }) });
}

afterEach(async () => {
  cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('version panel persisted HTTP flows', () => {
  it('recovers from branch validation, previews without writing, switches, and restores Undo as a new revision', async () => {
    const current = await fixture(); const initial = (await current.history()).commits[0].id;
    const view = render(<VersionPanel canvasId="product-roadmap" block={current.block} onChanged={current.onChanged} />);
    await screen.findByText('Current saved branch: main'); const input = screen.getByRole('textbox', { name: 'New branch name' });
    fireEvent.change(input, { target: { value: '../bad' } }); fireEvent.click(screen.getByRole('button', { name: 'Create branch' })); await screen.findByText('Invalid branch name');
    expect((await current.history()).branches).toEqual(['main']); expect((input as HTMLInputElement).value).toBe('../bad');
    fireEvent.change(input, { target: { value: 'experiment' } }); fireEvent.click(screen.getByRole('button', { name: 'Create branch' })); await screen.findByText(/Branch experiment created/);
    expect((await current.history()).branches).toContain('experiment'); expect((await current.readback()).blocks.find(block => block.id === current.block.id)?.content).toBe(current.block.content);
    view.unmount(); await prepareBranch('experiment', '# Experiment revision', true);
    render(<VersionPanel canvasId="product-roadmap" block={current.block} onChanged={current.onChanged} />); const writesBefore = current.network.writes.length;
    fireEvent.click(await screen.findByRole('button', { name: /⑂experiment/ })); await screen.findByText('# Experiment revision');
    expect((await current.history()).current).toBe('main'); expect((await current.readback()).blocks.find(block => block.id === current.block.id)?.content).toBe(current.block.content); expect(current.network.writes).toHaveLength(writesBefore);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' })); await screen.findByText(/Switch to experiment completed/); await waitFor(() => expect(current.onChanged).toHaveBeenCalledOnce());
    expect((await current.readback()).blocks.find(block => block.id === current.block.id)?.content).toBe('# Experiment revision'); expect((await current.history()).current).toBe('experiment');
    fireEvent.click(screen.getByRole('button', { name: 'Preview undo' })); await screen.findByText(/Applying this undo saves a new revision/); expect((await current.readback()).blocks.find(block => block.id === current.block.id)?.content).toBe('# Experiment revision');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' })); await screen.findByText(/Undo by restoring .* completed/); await waitFor(() => expect(current.onChanged).toHaveBeenCalledTimes(2));
    const saved = await current.readback(); const history = await current.history(); expect(saved.blocks.find(block => block.id === current.block.id)?.content).toBe(current.block.content); expect(history.current).toBe('experiment'); expect(history.commits[0].id).not.toBe(initial); expect(history.commits[0].author).toBe('Browser');
    expect(saved.blocks.filter(block => block.id !== current.block.id).map(block => [block.id, block.content, block.x, block.y])).toEqual(current.original.blocks.filter(block => block.id !== current.block.id).map(block => [block.id, block.content, block.x, block.y]));
  });

  it('previews and confirms a merge into the selected current branch through persisted HTTP history', async () => {
    const current = await fixture(); await prepareBranch('topic', '# Reviewed merge');
    render(<VersionPanel canvasId="product-roadmap" block={current.block} onChanged={current.onChanged} />); fireEvent.click(await screen.findByRole('button', { name: 'Preview merge into main' })); await screen.findByText('# Reviewed merge');
    expect((await current.readback()).blocks.find(block => block.id === current.block.id)?.content).toBe(current.block.content);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' })); await screen.findByText(/Merge topic into main completed/); await waitFor(() => expect(current.onChanged).toHaveBeenCalledOnce());
    expect((await current.history()).current).toBe('main'); expect((await current.readback()).blocks.find(block => block.id === current.block.id)?.content).toBe('# Reviewed merge');
  });

  it('reloads the saved history after a lost response without blindly applying the persisted switch again', async () => {
    const current = await fixture(); await prepareBranch('topic', '# Persisted despite lost response');
    render(<VersionPanel canvasId="product-roadmap" block={current.block} onChanged={current.onChanged} />); fireEvent.click(await screen.findByRole('button', { name: /⑂topic/ })); await screen.findByText('# Persisted despite lost response');
    const writesBefore = current.network.writes.length; current.network.dropNextSave = true; fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' })); await screen.findByText(/Could not confirm whether document content was saved/);
    expect((screen.getByRole('button', { name: 'Confirm switch' }) as HTMLButtonElement).disabled).toBe(true); expect(current.onChanged).not.toHaveBeenCalled(); expect((await current.readback()).blocks.find(block => block.id === current.block.id)?.content).toBe('# Persisted despite lost response');
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved history' })); await screen.findByText('Current saved branch: topic'); expect(screen.queryByRole('alert')).toBeNull(); expect(current.network.writes).toHaveLength(writesBefore + 1);
    expect((await api<VersionStatus>(versionsPath)).current).toBe('topic');
  });
});
