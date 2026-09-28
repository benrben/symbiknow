// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CanvasBlock } from '../shared/types';
import { VersionPanel } from './VersionPanel';
import { api } from './api';

vi.mock('./api', () => ({ api: vi.fn() }));
const mockedApi = vi.mocked(api);
const block = { id: 'document', title: 'Plan', file: 'plan.md', content: 'current', kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [] } as CanvasBlock;
const old = { id: 'a'.repeat(40), parents: [], message: 'First draft', author: 'Ada', createdAt: '2026-01-01T12:00:00Z' };
const status = { current: 'main', branches: ['main', 'draft'], commits: [old] };

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('VersionPanel', () => {
  it('labels unavailable saved history and retries loading it', async () => {
    let attempts = 0;
    mockedApi.mockImplementation(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('Offline')) : Promise.resolve(status) as ReturnType<typeof api>;
    });
    render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn()}/>);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load saved history');
    expect(screen.getByText(/Current saved branch: Unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved history' }));
    expect(await screen.findByText(/Current saved branch: main/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('requires a full read-only preview before switching branches and gives a saved receipt', async () => {
    let resolvePreview: (value: unknown) => void = () => undefined;
    mockedApi.mockImplementation((path, options) => {
      if (path.endsWith('/versions') && !options) return Promise.resolve(status) as ReturnType<typeof api>;
      if (path.includes('/preview?')) return new Promise(resolve => { resolvePreview = resolve; }) as ReturnType<typeof api>;
      return Promise.resolve({ ...status, current: 'draft' }) as ReturnType<typeof api>;
    });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<VersionPanel canvasId="canvas" block={block} onChanged={onChanged}/>);
    fireEvent.click(await screen.findByRole('button', { name: /draft/ }));
    const preview = screen.getByRole('region', { name: 'Version preview' });
    expect(within(preview).getByRole('button', { name: 'Confirm switch' }).hasAttribute('disabled')).toBe(true);
    expect(mockedApi.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    resolvePreview({ before: 'complete current document', after: 'complete draft document', scope: 'This document only', revision: old });
    expect(await within(preview).findByText('complete current document')).toBeTruthy();
    expect(within(preview).getByText('complete draft document')).toBeTruthy();
    expect(within(preview).getByText(/Ada/)).toBeTruthy();
    fireEvent.click(within(preview).getByRole('button', { name: 'Confirm switch' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(screen.getByRole('status').textContent).toContain('Document content is saved on draft');
  });

  it('shows a merge conflict and keeps apply disabled', async () => {
    mockedApi.mockImplementation(path => path.endsWith('/versions') ? Promise.resolve(status) as ReturnType<typeof api>
      : Promise.reject(new Error('Merge conflict in this document')));
    render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button', { name: /Preview merge/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Merge conflict');
    expect(screen.getByRole('button', { name: 'Confirm merge' }).hasAttribute('disabled')).toBe(true);
    expect(mockedApi.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain('Saved content is unchanged');
    expect(screen.getByRole('button', { name: 'Retry read-only preview' })).toBeTruthy();
  });

  it('offers a read-only undo preview after a successful save', async () => {
    mockedApi.mockImplementation((path, options) => {
      if (path.endsWith('/versions') && !options) return Promise.resolve(status) as ReturnType<typeof api>;
      if (path.includes('/preview?')) return Promise.resolve({ before: 'current', after: 'draft', scope: 'This document only', revision: old }) as ReturnType<typeof api>;
      return Promise.resolve({ ...status, current: 'draft', commits: [{ ...old, id: 'b'.repeat(40) }, old] }) as ReturnType<typeof api>;
    });
    render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn().mockResolvedValue(undefined)}/>);
    fireEvent.click(await screen.findByRole('button', { name: /draft/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm switch' }));
    expect(await screen.findByRole('button', { name: 'Preview undo' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Document content is saved');
    fireEvent.click(screen.getByRole('button', { name: 'Preview undo' }));
    expect(await screen.findByText(/Applying this undo saves a new revision/)).toBeTruthy();
    expect(mockedApi.mock.calls.find(([path]) => path.includes('/preview?kind=restore'))?.[0]).toContain('revision=' + old.id);
  });

  it('makes an uncertain save result safe to inspect before retrying', async () => {
    mockedApi.mockImplementation((path, options) => {
      if (path.endsWith('/versions') && !options) return Promise.resolve(status) as ReturnType<typeof api>;
      if (path.includes('/preview?')) return Promise.resolve({ before: 'current', after: 'draft', scope: 'This document only' }) as ReturnType<typeof api>;
      return Promise.reject(new Error('Connection lost'));
    });
    render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button', { name: /draft/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm switch' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not confirm whether document content was saved');
    expect(screen.getByRole('button', { name: 'Confirm switch' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved history' }));
    await waitFor(() => expect(mockedApi.mock.calls.filter(([path, options]) => path.endsWith('/versions') && !options)).toHaveLength(2));
  });

  it('inspects a revision before restore and reports a canvas refresh failure after saving', async () => {
    mockedApi.mockImplementation(path => {
      if (path.endsWith('/versions')) return Promise.resolve(status) as ReturnType<typeof api>;
      if (path.includes('/preview?')) return Promise.resolve({ before: 'new document', after: 'old document', scope: 'This document only', revision: old.id }) as ReturnType<typeof api>;
      return Promise.resolve(status) as ReturnType<typeof api>;
    });
    render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn().mockRejectedValue(new Error('Connection lost'))}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect revision' }));
    expect(await screen.findByText('old document')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Version preview' }).textContent).toContain('Ada');
    const previewCall = mockedApi.mock.calls.find(([path]) => path.includes('/preview?'));
    expect(previewCall?.[0]).toContain('revision=' + old.id);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('completed'));
    expect(screen.getByRole('alert').textContent).toContain('Document content was saved, but the canvas did not refresh');
  });

  it('opens an activity-linked revision in preview without restoring it', async () => {
    mockedApi.mockImplementation(path => path.endsWith('/versions') ? Promise.resolve(status) as ReturnType<typeof api>
      : Promise.resolve({ before: 'current', after: 'linked content', scope: 'This document only', revision: old }) as ReturnType<typeof api>);
    render(<VersionPanel canvasId="canvas" block={block} initialRevision={old.id} onChanged={vi.fn()}/>);
    expect(await screen.findByText('linked content')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Version preview' }).textContent).toContain('Inspect linked revision');
    expect(mockedApi.mock.calls.find(([path]) => path.includes('/preview?'))?.[0]).toContain('revision=' + old.id);
    expect(mockedApi.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });
});
