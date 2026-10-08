import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { JevWorkspaceFiles, outsideJevWorkspace } from './workspace.js';

let root: string;
let files: JevWorkspaceFiles;
function signal() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-workspace-lease-'));
  files = new JevWorkspaceFiles(root);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('permits awaited nested operations across instances of the same workspace queue', async () => {
  const other = new JevWorkspaceFiles(root);
  let nested!: Promise<void>;
  const events: string[] = [];
  try {
    await files.transaction('knowledge', async () => {
      events.push('outer-start');
      nested = other.serial('knowledge', async () => { events.push('nested'); });
      const completed = await Promise.race([
        nested.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
      ]);
      expect(completed).toBe(true);
      events.push('outer-end');
    });
  } finally { await nested; }
  expect(events).toEqual(['outer-start', 'nested', 'outer-end']);
});

it.each([false, true])('queues detached callbacks after their workspace operation settles (origin failed=%s)', async failed => {
  const wake = signal(); const entered = signal(); const finish = signal();
  const events: string[] = []; let detached!: Promise<void>;
  const failure = new Error('Workspace operation failed');
  const origin = files.transaction('knowledge', async () => {
    detached = (async () => {
      await wake.promise;
      await files.serial('knowledge', async () => { events.push('detached'); });
    })();
    if (failed) throw failure;
  });
  if (failed) await expect(origin).rejects.toBe(failure);
  else await origin;
  const blocker = files.serial('knowledge', async () => {
    events.push('blocker-start'); entered.release(); await finish.promise; events.push('blocker-end');
  });
  await entered.promise;
  try {
    wake.release(); await nextTurn();
    expect(events).toEqual(['blocker-start']);
  } finally { finish.release(); await Promise.all([blocker, detached]); }
  expect(events).toEqual(['blocker-start', 'blocker-end', 'detached']);
});

it('keeps a different workspace queue independent while the original workspace is occupied', async () => {
  const entered = signal(); const finish = signal(); const events: string[] = [];
  const other = files.serial('other', async () => { entered.release(); await finish.promise; events.push('other'); });
  await entered.promise;
  try {
    await files.transaction('knowledge', async () => {
      const pending = files.serial('other', async () => { events.push('nested-other'); });
      await nextTurn(); expect(events).toEqual([]); finish.release(); await pending;
    });
  } finally { finish.release(); await other; }
  expect(events).toEqual(['other', 'nested-other']);
});

it('queues background subscribers outside a still-active compound transaction', async () => {
  let background!: Promise<void>; const events: string[] = [];
  try {
    await files.transaction('knowledge', async () => {
      events.push('transaction-start');
      background = outsideJevWorkspace(() => files.serial('knowledge', async () => { events.push('background'); }));
      await nextTurn(); expect(events).toEqual(['transaction-start']);
      events.push('transaction-end');
    });
  } finally { await background; }
  expect(events).toEqual(['transaction-start', 'transaction-end', 'background']);
});
