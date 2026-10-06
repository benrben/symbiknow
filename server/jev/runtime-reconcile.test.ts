import { describe, expect, it } from 'vitest';
import { JevReconcileQueue } from './runtime-reconcile.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe('workspace reconciliation queue', () => {
  it('shares one pending result and combines simultaneous saves into the first and one trailing scan', async () => {
    const first = deferred(); const trailing = deferred(); let scans = 0;
    const queue = new JevReconcileQueue(async () => { scans += 1; await (scans === 1 ? first.promise : trailing.promise); });
    const initial = queue.request('workspace');
    const saves = Array.from({ length: 12 }, () => queue.request('workspace'));
    expect(saves.every(save => save === initial)).toBe(true);
    expect(scans).toBe(1);
    let completed = false; void initial.then(() => { completed = true; });
    first.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(scans).toBe(2); expect(completed).toBe(false);
    trailing.resolve(); await Promise.all([initial, ...saves]);
    expect(completed).toBe(true); expect(scans).toBe(2);
    await queue.request('workspace'); expect(scans).toBe(3);
  });

  it('keeps a different workspace independent of a held scan', async () => {
    const held = deferred(); const scans: string[] = [];
    const queue = new JevReconcileQueue(async workspaceId => { scans.push(workspaceId); if (workspaceId === 'held') await held.promise; });
    const first = queue.request('held');
    await queue.request('independent');
    expect(scans).toEqual(['held', 'independent']);
    held.resolve(); await first;
  });

  it('clears failed work for the next save to retry and exposes the same failure to every waiting save', async () => {
    const held = deferred(); const failure = new Error('Native workspace read failed'); let scans = 0;
    const queue = new JevReconcileQueue(async () => { scans += 1; if (scans === 1) { await held.promise; throw failure; } });
    const first = queue.request('workspace'); const second = queue.request('workspace');
    const rejected = Promise.all([expect(first).rejects.toBe(failure), expect(second).rejects.toBe(failure)]);
    held.resolve(); await rejected;
    await queue.request('workspace'); expect(scans).toBe(2);
  });

  it('retains the full pending promise when reconciliation synchronously causes another save', async () => {
    const held = deferred(); let scans = 0; let reentrant!: Promise<void>;
    const queue = new JevReconcileQueue(async () => {
      scans += 1;
      if (scans === 1) { reentrant = queue.request('workspace'); await held.promise; }
    });
    const first = queue.request('workspace');
    expect(reentrant).toBe(first);
    held.resolve(); await Promise.all([first, reentrant]); expect(scans).toBe(2);
  });

  it('retains a save made during the trailing scan in another fresh pass', async () => {
    const held = deferred(); let scans = 0;
    const queue = new JevReconcileQueue(async () => {
      scans += 1;
      if (scans === 1) await held.promise;
      if (scans === 2) void queue.request('workspace');
    });
    const first = queue.request('workspace'); void queue.request('workspace');
    held.resolve(); await first; expect(scans).toBe(3);
  });

  it('waits for the last edit in a burst before scanning, while new imports remain immediate', async () => {
    const scans: number[] = [];
    const queue = new JevReconcileQueue(async () => { scans.push(Date.now()); });
    const started = Date.now();
    const first = queue.request('edited', 40);
    await new Promise(resolve => setTimeout(resolve, 15));
    const same = queue.request('edited', 40);
    expect(same).toBe(first);
    await queue.request('fresh');
    expect(scans).toHaveLength(1);
    await first;
    expect(scans).toHaveLength(2);
    expect(scans[1] - started).toBeGreaterThanOrEqual(45);
  });

  it('registers an edit before its revision lookup finishes so an active scan still gets one trailing pass', async () => {
    const held = deferred(); const lookup = deferred(); let scans = 0;
    const queue = new JevReconcileQueue(async () => { scans += 1; if (scans === 1) await held.promise; });
    const first = queue.request('workspace');
    const edit = queue.request('workspace', lookup.promise.then(() => 0));
    expect(edit).toBe(first);
    held.resolve(); lookup.resolve();
    await first;
    expect(scans).toBe(2);
  });
});
