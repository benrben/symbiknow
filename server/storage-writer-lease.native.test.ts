import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { withinApiMutationAuthority } from './api-mutation-authority.js';
import { DocumentLocks } from './coordination.js';
import { CanvasStore } from './storage.js';
import { StorageFiles } from './storage-files.js';

let root: string;
let files: StorageFiles;
function signal() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'symbiknow-writer-lease-'));
  files = new StorageFiles(root, new DocumentLocks());
});
afterEach(async () => {
  await files.serialize(async () => undefined);
  await rm(root, { recursive: true, force: true });
});

it.each([false, true])('queues detached callbacks after their originating writer settles (origin failed=%s)', async failed => {
  const wake = signal(); const entered = signal(); const finish = signal();
  const events: string[] = []; let detached!: Promise<void>;
  const failure = new Error('Original write failed');
  const origin = files.serialize(async () => {
    detached = (async () => {
      await wake.promise;
      await files.serialize(async () => { events.push('detached'); await appendFile(path.join(root, 'order'), 'detached\n'); });
    })();
    if (failed) throw failure;
  });
  if (failed) await expect(origin).rejects.toBe(failure);
  else await origin;
  const blocker = files.serialize(async () => {
    events.push('blocker-start'); entered.release(); await finish.promise;
    await appendFile(path.join(root, 'order'), 'blocker\n'); events.push('blocker-end');
  });
  await entered.promise;
  try {
    wake.release(); await nextTurn();
    expect(events).toEqual(['blocker-start']);
  } finally { finish.release(); await Promise.all([blocker, detached]); }
  expect(events).toEqual(['blocker-start', 'blocker-end', 'detached']);
  expect(await readFile(path.join(root, 'order'), 'utf8')).toBe('blocker\ndetached\n');
});

it('preserves awaited reentry across same-root instances and independent nested roots', async () => {
  const sameRoot = new StorageFiles(root, new DocumentLocks());
  const otherRoot = new StorageFiles(path.join(root, 'other-root'), new DocumentLocks());
  const events: string[] = [];
  await files.serialize(async () => {
    events.push('outer-start');
    await sameRoot.serialize(async () => { events.push('same-root'); await appendFile(path.join(root, 'nested'), 'same\n'); });
    await otherRoot.serialize(async () => { events.push('other-root'); await appendFile(path.join(root, 'nested'), 'other\n'); });
    events.push('outer-end');
  });
  expect(events).toEqual(['outer-start', 'same-root', 'other-root', 'outer-end']);
  expect(await readFile(path.join(root, 'nested'), 'utf8')).toBe('same\nother\n');
});

it('rechecks captured request authority for an expired callback and continues the queue after authorization failure', async () => {
  const wake = signal(); const denied = new Error('Request grant revoked');
  let allowed = true; let checks = 0; let detached!: Promise<void>; let wrote = false;
  await withinApiMutationAuthority(async () => {
    checks++; if (!allowed) throw denied;
  }, () => files.serialize(async () => {
    detached = (async () => {
      await wake.promise;
      await files.serialize(async () => { wrote = true; await appendFile(path.join(root, 'authority'), 'unsafe\n'); });
    })();
  }));
  allowed = false; wake.release();
  await expect(detached).rejects.toBe(denied);
  expect(checks).toBe(2); expect(wrote).toBe(false);
  await files.serialize(() => appendFile(path.join(root, 'authority'), 'authorized-next\n'));
  expect(await readFile(path.join(root, 'authority'), 'utf8')).toBe('authorized-next\n');
});

it('keeps concurrent uploads when a delayed saved-source listener queues a native metadata update', async () => {
  const store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Native writer lease' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Source burst' });
  const wake = signal(); const entered = signal(); const finish = signal();
  let background!: Promise<void>; let backgroundEntered = false;
  const unsubscribe = store.onSaved(async event => {
    if (event.kind !== 'source' || event.actor !== 'First upload') return;
    background = (async () => {
      await wake.promise;
      await store.jevExecutor.serialized(async () => {
        backgroundEntered = true;
        await store.updateBlock(canvas.id, event.blockIds[0], { tags: ['Checked source'] }, 'Saved listener');
      });
    })();
    await background;
  });
  const first = await store.createBlock(canvas.id, { title: 'First source', content: '# First\nKeep the first upload bytes.' }, 'First upload');
  let second!: Awaited<ReturnType<CanvasStore['createBlock']>>;
  const blocker = store.jevExecutor.serialized(async () => {
    entered.release(); await finish.promise;
    second = await store.createBlock(canvas.id, { title: 'Second source', content: '# Second\nKeep the final upload bytes.' }, 'Second upload');
  });
  await entered.promise;
  try {
    wake.release(); await nextTurn();
    expect(backgroundEntered).toBe(false);
  } finally { finish.release(); await Promise.all([blocker, background]); unsubscribe(); }
  const reloaded = await new CanvasStore(root).getCanvas(canvas.id, true, false);
  expect(reloaded.blocks.map(block => block.id)).toEqual([first.id, second.id]);
  expect(reloaded.blocks[0]).toMatchObject({ content: first.content, tags: ['Checked source'] });
  expect(reloaded.blocks[1]).toMatchObject({ content: second.content });
});

it('queues an immediate saved-source listener until the publishing native writer completes', async () => {
  const store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Immediate saved listener' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Native sources' });
  let pending!: Promise<void>; let entered = false;
  const unsubscribe = store.onSaved(async event => {
    if (event.kind !== 'source') return;
    pending = store.jevExecutor.serialized(async () => {
      entered = true;
      await store.updateBlock(canvas.id, event.blockIds[0], { tags: ['Checked after upload'] }, 'Saved listener');
    });
    await pending;
  });
  let source!: Awaited<ReturnType<CanvasStore['createBlock']>>;
  try {
    await store.jevExecutor.serialized(async () => {
      source = await store.createBlock(canvas.id, { title: 'Native source', content: '# Native source\nKeep these uploaded bytes.' });
      await nextTurn();
      expect(entered).toBe(false);
    });
  } finally { await pending; unsubscribe(); }
  expect(await new CanvasStore(root).getCanvasBlock(canvas.id, source.id)).toMatchObject({
    content: source.content, tags: ['Checked after upload'] });
});
