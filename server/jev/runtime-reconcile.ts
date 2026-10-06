interface ReconcilePass { dirty: boolean; promise: Promise<void>; readyAt: number; quietRequests: Promise<void>[] }

/** Coalesce saved-source bursts while retaining a trailing pass for changes made during a scan. */
export class JevReconcileQueue {
  private readonly passes = new Map<string, ReconcilePass>();
  constructor(private readonly reconcile: (workspaceId: string) => Promise<void>) {}

  request(workspaceId: string, quietMs: number | Promise<number> = 0): Promise<void> {
    const previous = this.passes.get(workspaceId);
    if (previous) { previous.dirty = true; this.addQuietRequest(previous, quietMs); return previous.promise; }
    let complete!: () => void; let fail!: (reason: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    const pass: ReconcilePass = { dirty: false, promise, readyAt: 0, quietRequests: [] };
    this.addQuietRequest(pass, quietMs);
    this.passes.set(workspaceId, pass);
    // Publish the actual pending promise before a scan can synchronously cause another save.
    void this.drain(workspaceId, pass).then(complete, fail);
    return pass.promise;
  }

  private addQuietRequest(pass: ReconcilePass, quietMs: number | Promise<number>): void {
    if (typeof quietMs === 'number') {
      pass.readyAt = Math.max(pass.readyAt, Date.now() + Math.max(0, quietMs));
      return;
    }
    pass.quietRequests.push(quietMs.then(value => {
      pass.readyAt = Math.max(pass.readyAt, Date.now() + Math.max(0, value));
    }));
  }

  private async drain(workspaceId: string, pass: ReconcilePass): Promise<void> {
    try {
      do {
        while (pass.quietRequests.length || pass.readyAt > Date.now()) {
          if (pass.quietRequests.length) await Promise.all(pass.quietRequests.splice(0));
          if (pass.readyAt > Date.now()) await new Promise(resolve => setTimeout(resolve, pass.readyAt - Date.now()));
        }
        pass.dirty = false;
        await this.reconcile(workspaceId);
      } while (pass.dirty);
    } finally { this.passes.delete(workspaceId); }
  }
}
