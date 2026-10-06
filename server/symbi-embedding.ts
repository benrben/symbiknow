import { Worker, type WorkerOptions } from 'node:worker_threads';
import { resolve } from 'node:path';

export const MINILM_MODEL_VERSION = 'Xenova/all-MiniLM-L6-v2@57cbdab1181b7eba8170805260bd39e733b0e25d:int8';

export interface SymbiEmbedder {
  readonly modelVersion: string;
  embed(texts: string[]): Promise<number[][]>;
  close?(): Promise<void>;
}

type Pending = { resolve: (vectors: number[][]) => void; reject: (error: Error) => void };

function batchExceedsLimit(texts: string[]): boolean {
  return texts.length > 32 || texts.some((text) => text.length > 1600);
}

/** One worker, bounded queue, and no network access from model loading. */
export class MiniLmEmbedder implements SymbiEmbedder {
  readonly modelVersion = MINILM_MODEL_VERSION;
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly options: { modelRoot?: string; cacheDir: string; maxPending?: number;
    workerFactory?: (url: URL, options: WorkerOptions) => Worker }) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (this.closed) throw new Error('Embedding worker is closed');
    if (texts.length === 0) return [];
    if (batchExceedsLimit(texts)) {
      throw new Error('Embedding batch exceeds bounded worker input');
    }
    if (this.pending.size >= (this.options.maxPending ?? 64)) {
      throw new Error('Embedding worker queue is full');
    }
    const id = ++this.nextId;
    const worker = this.getWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, texts });
    });
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.startWorker();
    worker.on('message', (message: { id: number; vectors?: number[][]; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else if (message.vectors) pending.resolve(message.vectors);
      else pending.reject(new Error('Embedding worker returned no vectors'));
    });
    worker.on('error', (error) => this.failAll(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', (code) => {
      this.worker = undefined;
      if (!this.closed) this.failAll(new Error(`Embedding worker exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }

  private startWorker(): Worker {
    const url = new URL('./symbi-embedding-worker.mjs', import.meta.url);
    const options: WorkerOptions = {
      workerData: {
        modelRoot: this.options.modelRoot && resolve(this.options.modelRoot),
        cacheDir: resolve(this.options.cacheDir),
      },
    };
    return this.options.workerFactory?.(url, options) ?? new Worker(url, options);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error('Embedding worker closed'));
    if (this.worker) await this.worker.terminate();
    this.worker = undefined;
  }
}
