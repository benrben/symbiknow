import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import { afterEach, expect, it } from 'vitest';
import { MiniLmEmbedder, MINILM_MODEL_VERSION } from './symbi-embedding.js';

const roots: string[] = [];
const embedders: MiniLmEmbedder[] = [];
afterEach(async () => {
  await Promise.all(embedders.splice(0).map((embedder) => embedder.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { maxPending?: number } = {}): Promise<MiniLmEmbedder> {
  const root = await mkdtemp(join(tmpdir(), 'symbi-embedding-test-'));
  roots.push(root);
  const embedder = new MiniLmEmbedder({ modelRoot: join(root, 'missing-model'), cacheDir: root, ...options });
  embedders.push(embedder);
  return embedder;
}

class ControlledWorker extends EventEmitter {
  readonly sent: { id: number; texts: string[] }[] = [];
  postMessage(message: { id: number; texts: string[] }): void { this.sent.push(message); }
  async terminate(): Promise<number> { this.emit('exit', 0); return 0; }
}

async function controlledFixture(): Promise<{ embedder: MiniLmEmbedder; worker: ControlledWorker; options: WorkerOptions }> {
  const root = await mkdtemp(join(tmpdir(), 'symbi-embedding-controlled-'));
  roots.push(root);
  const worker = new ControlledWorker();
  let workerOptions: WorkerOptions | undefined;
  const embedder = new MiniLmEmbedder({ modelRoot: join(root, 'model'), cacheDir: root,
    workerFactory: (url, options) => {
      expect(url.pathname).toMatch(/symbi-embedding-worker\.mjs$/);
      workerOptions = options;
      return worker as unknown as Worker;
    },
  });
  embedders.push(embedder);
  const first = embedder.embed(['probe']);
  expect(worker.sent).toHaveLength(1);
  worker.emit('message', { id: worker.sent[0].id, vectors: [[1, 0]] });
  await expect(first).resolves.toEqual([[1, 0]]);
  if (!workerOptions) throw new Error('Worker options were not captured');
  return { embedder, worker, options: workerOptions };
}

it('bounds empty, oversized, and queued inputs before local model work', async () => {
  const embedder = await fixture({ maxPending: 1 });
  expect(embedder.modelVersion).toBe(MINILM_MODEL_VERSION);
  await expect(embedder.embed([])).resolves.toEqual([]);
  await expect(embedder.embed(Array.from({ length: 33 }, () => 'bounded'))).rejects.toThrow('batch exceeds');
  await expect(embedder.embed(['x'.repeat(1601)])).rejects.toThrow('batch exceeds');
  const pending = embedder.embed(['first request']);
  const pendingRejection = expect(pending).rejects.toThrow('Offline INT8 MiniLM model is missing');
  await expect(embedder.embed(['second request'])).rejects.toThrow('queue is full');
  await pendingRejection;
});

it('surfaces the offline worker failure for successive requests and rejects a request after close', async () => {
  const embedder = await fixture();
  await expect(embedder.embed(['first'])).rejects.toThrow('Offline INT8 MiniLM model is missing');
  await expect(embedder.embed(['second'])).rejects.toThrow('Offline INT8 MiniLM model is missing');
  await embedder.close();
  await embedder.close();
  await expect(embedder.embed(['after close'])).rejects.toThrow('Embedding worker is closed');
});

it('rejects an outstanding request when the embedding worker closes', async () => {
  const embedder = await fixture();
  const pending = embedder.embed(['request before shutdown']);
  const pendingRejection = expect(pending).rejects.toThrow('Embedding worker closed');
  await embedder.close();
  await pendingRejection;
});

it('passes only local model paths and ignores replies for unknown requests', async () => {
  const { embedder, worker, options } = await controlledFixture();
  expect(options.workerData.modelRoot).toMatch(/\/model$/);
  expect(options.workerData.cacheDir).toMatch(/symbi-embedding-controlled-/);
  const pending = embedder.embed(['another probe']);
  worker.emit('message', { id: -1, vectors: [[9, 9]] });
  worker.emit('message', { id: worker.sent.at(-1)?.id, vectors: [[0, 1]] });
  await expect(pending).resolves.toEqual([[0, 1]]);
});

it('rejects a malformed worker response without poisoning later requests', async () => {
  const { embedder, worker } = await controlledFixture();
  const malformed = embedder.embed(['malformed']);
  const rejection = expect(malformed).rejects.toThrow('returned no vectors');
  worker.emit('message', { id: worker.sent.at(-1)?.id });
  await rejection;
  const recovered = embedder.embed(['recovered']);
  worker.emit('message', { id: worker.sent.at(-1)?.id, vectors: [[0.5, 0.5]] });
  await expect(recovered).resolves.toEqual([[0.5, 0.5]]);
});

it('rejects queued requests on worker errors and unexpected exit, then restarts', async () => {
  const { embedder, worker } = await controlledFixture();
  const failed = embedder.embed(['first pending']);
  const failure = expect(failed).rejects.toThrow('worker fault');
  worker.emit('error', new Error('worker fault'));
  await failure;
  const nonError = embedder.embed(['non-error failure']);
  const nonErrorFailure = expect(nonError).rejects.toThrow('string fault');
  worker.emit('error', 'string fault');
  await nonErrorFailure;
  const stopped = embedder.embed(['second pending']);
  const stoppedFailure = expect(stopped).rejects.toThrow('exited with code 7');
  worker.emit('exit', 7);
  await stoppedFailure;
  const restarted = embedder.embed(['after exit']);
  worker.emit('message', { id: worker.sent.at(-1)?.id, vectors: [[1, 1]] });
  await expect(restarted).resolves.toEqual([[1, 1]]);
});
