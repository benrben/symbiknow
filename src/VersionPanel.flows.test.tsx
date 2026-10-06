// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionPanel } from './VersionPanel';
import { useVersionPanel } from './useVersionPanel';
import type { CanvasBlock } from '../shared/types';

const block: CanvasBlock = { id: 'document', title: 'Plan', file: 'plan.md', content: 'Current', kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [] };
const other = { ...block, id: 'other', title: 'Other plan', file: 'other.md' };
const commit = { id: 'a'.repeat(40), parents: [], message: 'First draft', author: 'Ada', createdAt: '2026-01-01T12:00:00Z' };
const status = { current: 'main', branches: ['main', 'draft'], commits: [commit] };
const otherStatus = { current: 'other-main', branches: ['other-main', 'draft'], commits: [{ ...commit, id: 'b'.repeat(40), message: 'Other document revision' }] };
const preview = { before: 'Current complete content', after: 'Earlier complete content', scope: 'This document only', revision: commit };
function held() { let resolve!: (value: Response) => void; let reject!: (reason: unknown) => void; const promise = new Promise<Response>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('version panel document ownership', () => {
  it('invalidates a held preview when the panel changes to another document', async () => {
    const pending = held(); vi.mocked(fetch).mockImplementation(async input => String(input).includes('/preview?') ? pending.promise : Response.json(String(input).includes('/other/') ? otherStatus : status));
    const view = render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: /⑂draft/ }));
    view.rerender(<VersionPanel canvasId="canvas" block={other} onChanged={vi.fn()} />); await screen.findByText('Other document revision'); await act(async () => pending.resolve(Response.json(preview)));
    expect(screen.queryByRole('region', { name: 'Version preview' })).toBeNull(); expect(screen.queryByText(preview.after)).toBeNull(); expect(screen.queryByRole('button', { name: 'Confirm switch' })).toBeNull();
  });

  it.each(['success', 'failure'] as const)('does not put an old document’s pending save %s into the new document panel', async outcome => {
    const pending = held(); vi.mocked(fetch).mockImplementation(async (input, options) => {
      if (options?.method === 'POST') return pending.promise; if (String(input).includes('/preview?')) return Response.json(preview); return Response.json(String(input).includes('/other/') ? otherStatus : status);
    });
    const onChanged = vi.fn(); const view = render(<VersionPanel canvasId="canvas" block={block} onChanged={onChanged} />); fireEvent.click(await screen.findByRole('button', { name: /⑂draft/ })); fireEvent.click(await screen.findByRole('button', { name: 'Confirm switch' }));
    view.rerender(<VersionPanel canvasId="canvas" block={other} onChanged={vi.fn()} />); await screen.findByText('Other document revision');
    await act(async () => { if (outcome === 'success') pending.resolve(Response.json({ ...status, current: 'draft' })); else pending.reject(new Error('Late connection failure')); });
    expect(screen.getByText('Current saved branch: other-main')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByText(/completed\. Document content/)).toBeNull(); expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('branch creation and preview recovery', () => {
  it('retries a failed read-only preview before enabling a save', async () => {
    let previews = 0; vi.mocked(fetch).mockImplementation(async input => String(input).includes('/preview?') ? ++previews === 1 ? Response.json({ error: 'Preview temporarily unavailable' }, { status: 503 }) : Response.json(preview) : Response.json(status));
    render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: /⑂draft/ }));
    await screen.findByText(/Preview temporarily unavailable/); expect((screen.getByRole('button', { name: 'Confirm switch' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry read-only preview' })); await screen.findByText(preview.after); expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Confirm switch' }) as HTMLButtonElement).disabled).toBe(false); expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('ignores a failed canvas refresh after the saved document is no longer open', async () => {
    const refresh = held(); vi.mocked(fetch).mockImplementation(async input => String(input).includes('/preview?') ? Response.json(preview) : Response.json(String(input).includes('/other/') ? otherStatus : status));
    const onChanged = vi.fn(() => refresh.promise.then(() => undefined)); const view = render(<VersionPanel canvasId="canvas" block={block} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: /⑂draft/ })); fireEvent.click(await screen.findByRole('button', { name: 'Confirm switch' })); await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    view.rerender(<VersionPanel canvasId="canvas" block={other} onChanged={vi.fn()} />); await screen.findByText('Other document revision'); await act(async () => refresh.reject(new Error('Late canvas refresh failure')));
    expect(screen.getByText('Current saved branch: other-main')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rejects premature and repeated public model apply calls without writing', async () => {
    const pendingPreview = held(); const pendingWrite = held(); vi.mocked(fetch).mockImplementation(async (input, options) => options?.method === 'POST' ? pendingWrite.promise : String(input).includes('/preview?') ? pendingPreview.promise : Response.json(status));
    const { result } = renderHook(() => useVersionPanel({ canvasId: 'canvas', block, onChanged: vi.fn() })); await waitFor(() => expect(result.current.status?.current).toBe('main'));
    await act(async () => result.current.apply()); let reading!: Promise<void>; act(() => { reading = result.current.choose({ kind: 'switch', value: 'draft', label: 'Switch to draft' }); }); await act(async () => result.current.apply());
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0); await act(async () => { pendingPreview.resolve(Response.json(preview)); await reading; });
    let writing!: Promise<void>; act(() => { writing = result.current.apply(); }); await act(async () => result.current.apply()); expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    await act(async () => { pendingWrite.resolve(Response.json({ ...status, current: 'draft' })); await writing; }); expect(result.current.busy).toBe(false); expect(result.current.status?.current).toBe('draft');
  });

  it('ignores a StrictMode effect’s late history while the current effect remains pending', async () => {
    const initial = held(); const current = held(); vi.mocked(fetch).mockReturnValueOnce(initial.promise).mockReturnValueOnce(current.promise);
    render(<StrictMode><VersionPanel canvasId="canvas" block={block} onChanged={vi.fn()} /></StrictMode>); expect(fetch).toHaveBeenCalledTimes(2); await act(async () => initial.resolve(Response.json(otherStatus)));
    expect(screen.getByText('Current saved branch: Loading…')).toBeTruthy(); expect(screen.queryByText('0 shown')).toBeNull(); expect(screen.queryByText('Other document revision')).toBeNull(); await act(async () => current.resolve(Response.json(status))); expect(screen.getByText('Current saved branch: main')).toBeTruthy(); expect(screen.getByText(`${status.commits.length} shown`)).toBeTruthy();
  });

  it('ignores blank branch forms, keeps failed branch names for retry, and gives a creation receipt after success', async () => {
    let attempt = 0; vi.mocked(fetch).mockImplementation(async (_input, options) => options?.method === 'POST' ? ++attempt === 1 ? Response.json({ error: 'Invalid branch name' }, { status: 400 }) : Response.json({ ...status, branches: [...status.branches, 'topic'] }) : Response.json(status));
    render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn()} />); await screen.findByText('Current saved branch: main'); const input = screen.getByRole('textbox', { name: 'New branch name' });
    fireEvent.change(input, { target: { value: '   ' } }); fireEvent.submit(input.closest('form')!); expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: ' topic ' } }); fireEvent.click(screen.getByRole('button', { name: 'Create branch' })); await screen.findByText('Invalid branch name'); expect((input as HTMLInputElement).value).toBe(' topic ');
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' })); await screen.findByText('Branch topic created. Document content is unchanged; current branch: main.'); expect((input as HTMLInputElement).value).toBe(''); expect(screen.queryByRole('alert')).toBeNull();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body))).toEqual({ name: 'topic' });
  });

  it('uses the selected merge target and falls back to another branch after that target becomes current', async () => {
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      if (String(input).includes('/preview?')) return Response.json(preview); return Response.json(options?.method === 'POST' ? { ...status, current: 'draft' } : { ...status, branches: [...status.branches, 'topic'] });
    });
    render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn()} />); const select = await screen.findByRole('combobox', { name: 'Branch to merge' }); fireEvent.change(select, { target: { value: 'topic' } }); fireEvent.click(screen.getByRole('button', { name: 'Preview merge into main' })); await screen.findByText(preview.after);
    expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toContain('preview?kind=merge&name=topic'); fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(select, { target: { value: 'draft' } }); fireEvent.click(screen.getByRole('button', { name: /⑂draft/ })); fireEvent.click(await screen.findByRole('button', { name: 'Confirm switch' })); await screen.findByText('Current saved branch: draft'); expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('main');
  });

  it.each(['success', 'failure'] as const)('ignores a cancelled preview’s late %s while a newer preview remains pending', async outcome => {
    const old = held(); const newer = held(); let calls = 0; vi.mocked(fetch).mockImplementation(async input => String(input).includes('/preview?') ? ++calls === 1 ? old.promise : newer.promise : Response.json(status));
    render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: /⑂draft/ })); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); fireEvent.click(screen.getByRole('button', { name: 'Inspect revision' }));
    await act(async () => { if (outcome === 'success') old.resolve(Response.json(preview)); else old.reject(new Error('Late preview failure')); }); expect(screen.getByText('Loading read-only preview. Saved content is unchanged…')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByRole('button', { name: 'Confirm restore' }).hasAttribute('disabled')).toBe(true);
    await act(async () => newer.resolve(Response.json({ ...preview, revision: 'unknown', before: '', after: '' }))); expect(screen.getAllByText('(empty document)')).toHaveLength(2); expect(screen.getByText(/Unknown author · Date unavailable/)).toBeTruthy();
  });

  it.each(['success', 'failure'] as const)('ignores initial history %s after unmount', async outcome => {
    const pending = held(); vi.mocked(fetch).mockReturnValue(pending.promise); const view = render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn()} />); view.unmount();
    await act(async () => { if (outcome === 'success') pending.resolve(Response.json(status)); else pending.reject(new Error('Late history failure')); }); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'] as const)('ignores old branch creation %s after changing documents', async outcome => {
    const pending = held(); vi.mocked(fetch).mockImplementation(async (input, options) => options?.method === 'POST' ? pending.promise : Response.json(String(input).includes('/other/') ? otherStatus : status));
    const view = render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn()} />); fireEvent.change(await screen.findByRole('textbox', { name: 'New branch name' }), { target: { value: 'old-topic' } }); await screen.findByText('Current saved branch: main'); fireEvent.click(screen.getByRole('button', { name: 'Create branch' }));
    view.rerender(<VersionPanel canvasId="canvas" block={other} onChanged={vi.fn()} />); await screen.findByText('Other document revision'); await act(async () => { if (outcome === 'success') pending.resolve(Response.json({ ...status, branches: [...status.branches, 'old-topic'] })); else pending.reject(new Error('Late create failure')); });
    expect(screen.getByText('Current saved branch: other-main')).toBeTruthy(); expect(screen.queryByText(/Branch old-topic created/)).toBeNull(); expect(screen.queryByRole('alert')).toBeNull(); expect((screen.getByRole('textbox', { name: 'New branch name' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('handles history without commits and saves a current-revision receipt when metadata is unavailable', async () => {
    vi.mocked(fetch).mockImplementation(async input => String(input).includes('/preview?') ? Response.json({ before: '', after: '', scope: 'This document only' }) : Response.json({ ...status, commits: [] }));
    render(<VersionPanel canvasId="canvas" block={block} onChanged={vi.fn().mockRejectedValue('Unknown refresh failure')} />); fireEvent.click(await screen.findByRole('button', { name: /⑂draft/ })); fireEvent.click(await screen.findByRole('button', { name: 'Confirm switch' }));
    await screen.findByText(/at revision current/); expect(screen.queryByRole('button', { name: 'Preview undo' })).toBeNull(); expect(screen.getByRole('alert').textContent).toContain('Could not change history. Try again.');
  });
});
