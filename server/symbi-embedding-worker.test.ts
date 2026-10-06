import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => ({ __symbiTestMock: true,
  env: { backends: { onnx: { wasm: {} } } }, pipeline: async () => () => ({ data: Float32Array.of(1) }) }));

const workers: Worker[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('returns an offline model error for each request and stays available for a subsequent request', async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), 'symbi-missing-model-'));
  dirs.push(modelRoot);
  const worker = new Worker(new URL('./symbi-embedding-worker.mjs', import.meta.url), {
    workerData: { modelRoot, cacheDir: modelRoot },
  });
  workers.push(worker);
  async function request(id: number): Promise<{ id: number; error?: string }> {
    return new Promise((resolve, reject) => {
      const onMessage = (message: { id: number; error?: string }) => {
        if (message.id !== id) return;
        worker.off('error', onError);
        resolve(message);
      };
      const onError = (error: Error) => { worker.off('message', onMessage); reject(error); };
      worker.once('message', onMessage);
      worker.once('error', onError);
      worker.postMessage({ id, texts: ['offline check'] });
    });
  }
  expect(await request(1)).toMatchObject({ id: 1, error: expect.stringContaining('Offline INT8 MiniLM model is missing') });
  expect(await request(2)).toMatchObject({ id: 2, error: expect.stringContaining('Offline INT8 MiniLM model is missing') });
});

it('reports the real offline loading failure through the request catch and accepts a later successful request', async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), 'symbi-handler-missing-model-'));
  dirs.push(modelRoot);
  const moduleUrl = new URL('./symbi-embedding-worker.mjs', import.meta.url).href;
  const { handle } = await import(moduleUrl) as { handle: (
    request: { id: number; texts: string[] },
    port: { postMessage: (message: unknown) => void },
    options: { modelRoot: string; cacheDir: string },
    loadModel?: () => Promise<(text: string) => Promise<{ data: Float32Array }>>,
  ) => Promise<void> };
  const responses: unknown[] = [];
  const port = { postMessage: (message: unknown) => { responses.push(message); } };
  const options = { modelRoot, cacheDir: modelRoot };
  await handle({ id: 1, texts: ['offline check'] }, port, options);
  expect(responses[0]).toMatchObject({ id: 1, error: expect.stringContaining('Offline INT8 MiniLM model is missing') });
  await handle({ id: 2, texts: ['recovered check'] }, port, options,
    async () => async () => ({ data: Float32Array.of(1, 2) }));
  expect(responses[1]).toEqual({ id: 2, vectors: [[1, 2]] });
  await handle({ id: 3, texts: ['bad loader check'] }, port, options,
    async () => Promise.reject('temporary loader failure'));
  expect(responses[2]).toEqual({ id: 3, error: 'temporary loader failure' });
});

it('checks local artifact bytes and configures the pipeline for offline INT8 CPU inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symbi-worker-offline-artifact-'));
  dirs.push(root);
  const artifactDir = join(root, 'Xenova', 'all-MiniLM-L6-v2');
  await mkdir(artifactDir, { recursive: true });
  const modelFile = join(artifactDir, 'model_int8.onnx');
  const modelBytes = Buffer.from('local checksum fixture: never a remote model');
  await writeFile(modelFile, modelBytes);
  const checksum = createHash('sha256').update(modelBytes).digest('hex');
  const moduleUrl = new URL('./symbi-embedding-worker.mjs', import.meta.url).href;
  const { load, verifyModel, productionDependencies } = await import(moduleUrl) as {
    verifyModel: (file: string, expectedSha: string) => Promise<void>;
    productionDependencies: { expectedSha: string; loadPackage: () => Promise<{ pipeline: unknown; __symbiTestMock?: boolean }> };
    load: (options: { modelRoot?: string; cacheDir: string }, dependencies: {
      expectedSha: string; loadPackage: () => Promise<{ env: Record<string, unknown>; pipeline: typeof pipeline }>,
    }) => Promise<(text: string) => Promise<{ data: Float32Array }>>;
  };
  const env = { allowRemoteModels: true, allowLocalModels: false, localModelPath: '', cacheDir: '',
    backends: { onnx: { wasm: { numThreads: 0 } } } };
  const extractor = async () => ({ data: Float32Array.of(1, 0) });
  const pipeline = vi.fn(async () => extractor);
  const loadPackage = vi.fn(async () => ({ env, pipeline }));
  await expect(verifyModel(modelFile, checksum)).resolves.toBeUndefined();
  await expect(verifyModel(modelFile, 'incorrect-digest')).rejects.toThrow('checksum mismatch');
  await expect(load({ cacheDir: root }, { expectedSha: checksum, loadPackage }))
    .rejects.toThrow('no modelRoot configured');
  const loaded = await load({ modelRoot: root, cacheDir: root }, { expectedSha: checksum, loadPackage });
  expect(loaded).toBe(extractor);
  expect(env).toMatchObject({ allowRemoteModels: false, allowLocalModels: true,
    localModelPath: root, cacheDir: root, backends: { onnx: { wasm: { numThreads: 2 } } } });
  expect(pipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2',
    expect.objectContaining({ revision: '57cbdab1181b7eba8170805260bd39e733b0e25d', dtype: 'int8',
      model_file_name: 'model', local_files_only: true, device: 'cpu' }));
  expect(await load({ modelRoot: join(root, 'missing'), cacheDir: root }, { expectedSha: 'bad', loadPackage }))
    .toBe(extractor);
  expect(loadPackage).toHaveBeenCalledTimes(1);
  expect(productionDependencies.expectedSha).toMatch(/^[a-f0-9]{64}$/);
  expect(await productionDependencies.loadPackage()).toMatchObject({ __symbiTestMock: true, pipeline: expect.any(Function) });
});

it('imports the installed Transformers package in an isolated offline child process', () => {
  const moduleUrl = new URL('./symbi-embedding-worker.mjs', import.meta.url).href;
  const script = `const { productionDependencies } = await import(${JSON.stringify(moduleUrl)});
    const pkg = await productionDependencies.loadPackage();
    if (typeof pkg.pipeline !== 'function') throw new Error('Installed package has no pipeline');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Isolated Transformers import failed: ${result.error?.message ?? result.stderr}`);
  }
});
