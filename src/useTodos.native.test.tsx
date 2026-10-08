// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTodos } from './useTodos';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';
import { api } from './api';
import type { CanvasTask } from '../shared/types';

afterEach(async () => { cleanup(); await closeWorkspaceFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
async function session() {
  const fixture = await workspaceFixture(); const hook = renderHook(() => useTodos(fixture.canvas.id));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { fixture, hook, path: `/api/canvases/${fixture.canvas.id}/todos` };
}
it('displays native read errors, retries successfully, and ignores obsolete successful and failed reads', async () => {
  const { fixture, hook, path } = await session();
  const stale = fixture.hold(path, 'GET');
  let older!: Promise<unknown>; act(() => { older = hook.result.current.refresh(); }); await stale.response;
  await act(async () => { await hook.result.current.save({ title: 'Fresh task' }); });
  await act(async () => { await stale.release(); await older; }); expect(hook.result.current.tasks[0].title).toBe('Fresh task');
  const failed = fixture.hold(path, 'GET'); act(() => { older = hook.result.current.refresh(); }); await failed.response;
  await act(async () => { await hook.result.current.refresh(); failed.fail('Obsolete read failure'); await older; }); expect(hook.result.current.error).toBe('');
  const current = fixture.hold(path, 'GET'); act(() => { older = hook.result.current.refresh(); }); await current.response;
  await act(async () => { current.fail('Readable outage'); await older; }); expect(hook.result.current.error).toBe('Readable outage');
  await act(async () => { await hook.result.current.refresh(); }); expect(hook.result.current.error).toBe('');
});

it('ignores reads and write successes after unmount and refuses parallel writes or reads during a pending mutation', async () => {
  const { fixture, hook, path } = await session(); const held = fixture.hold(path, 'POST');
  let write!: Promise<boolean>; act(() => { write = hook.result.current.save({ title: 'Pending task' }); }); await held.response;
  const before = fixture.calls.length;
  await act(async () => { expect(await hook.result.current.save({ title: 'Duplicate' })).toBe(false); await hook.result.current.refresh(); }); expect(fixture.calls).toHaveLength(before);
  hook.unmount(); await act(async () => { await held.release(); expect(await write).toBe(false); });
  const second = renderHook(() => useTodos(fixture.canvas.id)); await waitFor(() => expect(second.result.current.loading).toBe(false));
  const read = fixture.hold(path, 'GET'); let loading!: Promise<unknown>; act(() => { loading = second.result.current.refresh(); }); await read.response;
  second.unmount(); await act(async () => { await read.release(); await loading; });
  expect((await api<CanvasTask[]>(path.slice(4))).map(task => task.title)).toEqual(['Pending task']);
});

it('ignores failed writes and failed reads after unmount', async () => {
  const { fixture, hook, path } = await session();
  const failure = fixture.hold(path, 'POST'); let pending!: Promise<boolean>;
  act(() => { pending = hook.result.current.save({ title: 'Delayed receipt' }); }); await failure.response; hook.unmount();
  await act(async () => { failure.fail('Disconnected write'); expect(await pending).toBe(false); });
  const next = renderHook(() => useTodos(fixture.canvas.id)); await waitFor(() => expect(next.result.current.loading).toBe(false));
  const read = fixture.hold(path, 'GET'); let loading!: Promise<unknown>; act(() => { loading = next.result.current.refresh(); }); await read.response;
  next.unmount(); await act(async () => { read.fail('Disconnected read'); await loading; });
});

it('refreshes MCP writes periodically and updates a legacy task whose revision is absent', async () => {
  const fixture = await workspaceFixture(); const path = `/api/canvases/${fixture.canvas.id}/todos`;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const hook = renderHook(() => useTodos(fixture.canvas.id)); await act(async () => { await hook.result.current.refresh(); });
  await api(path.slice(4), { method: 'POST', body: JSON.stringify({ title: 'Agent task' }) });
  const periodic = fixture.hold(path, 'GET');
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); await periodic.response; await periodic.release(); });
  expect(hook.result.current.tasks).toHaveLength(1);
  const legacy = { ...hook.result.current.tasks[0], revision: undefined };
  await act(async () => { expect(await hook.result.current.save({ status: 'done' }, legacy)).toBe(false); });
  expect(fixture.calls.at(-1)?.body.expectedRevision).toBe(0); expect(hook.result.current.error).toMatch(/still here/);
});
