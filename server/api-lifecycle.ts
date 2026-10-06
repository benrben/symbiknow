import type { Server } from 'node:http';

type CloseCallback = (error?: Error) => void;

/** Node may finish a response before its durable audit and source-event tail. */
export class ApiLifecycle {
  private readonly requests = new Set<Promise<void>>();
  private shutdownWork?: Promise<void>;

  constructor(private readonly stop: () => void, private readonly settle: () => Promise<void>) {}

  async track(work: Promise<void>): Promise<void> {
    this.requests.add(work);
    try { await work; }
    finally { this.requests.delete(work); }
  }

  shutdown(): Promise<void> {
    this.stop();
    this.shutdownWork ??= this.finish();
    return this.shutdownWork;
  }

  private async finish(): Promise<void> {
    while (this.requests.size) await Promise.allSettled([...this.requests]);
    await this.settle();
  }

  install(server: Server): void {
    const close = server.close.bind(server);
    server.close = callback => {
      this.stop();
      return close(error => {
        void this.shutdown().then(() => callback?.(error), failure => this.failedClose(failure, callback));
      });
    };
    server.once('close', this.stop);
  }

  private failedClose(error: Error, callback?: CloseCallback): void {
    if (callback) callback(error);
    else console.error('API shutdown requires durable recovery:', error);
  }
}
