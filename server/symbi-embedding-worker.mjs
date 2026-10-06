import { parentPort, workerData } from 'node:worker_threads';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const REVISION = '57cbdab1181b7eba8170805260bd39e733b0e25d';
const MODEL_SHA256 = 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1';
let extractor;
let work = Promise.resolve();
const packageName = '@huggingface/transformers';
export const productionDependencies = { expectedSha: MODEL_SHA256, loadPackage: () => import(packageName) };

export async function verifyModel(path, expectedSha) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  if (digest.digest('hex') !== expectedSha) throw new Error('Pinned INT8 MiniLM model checksum mismatch');
}

export async function load(options = workerData, dependencies = productionDependencies) {
  if (extractor) return extractor;
  const root = options?.modelRoot;
  const modelPath = root && join(root, MODEL, 'model_int8.onnx');
  if (!modelPath || !existsSync(modelPath)) {
    throw new Error(`Offline INT8 MiniLM model is missing under ${root || '(no modelRoot configured)'}`);
  }
  await verifyModel(modelPath, dependencies.expectedSha);
  const { env, pipeline } = await dependencies.loadPackage();
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = root;
  env.cacheDir = options?.cacheDir;
  env.backends.onnx.wasm.numThreads = 2;
  extractor = await pipeline('feature-extraction', MODEL, {
    revision: REVISION,
    dtype: 'int8',
    model_file_name: 'model',
    subfolder: '',
    local_files_only: true,
    device: 'cpu',
  });
  return extractor;
}

export async function handle({ id, texts }, port = parentPort, options = workerData, loadModel = load) {
  try {
    const model = await loadModel(options);
    const vectors = [];
    for (const text of texts) {
      const output = await model(text, { pooling: 'mean', normalize: true });
      vectors.push(Array.from(output.data));
    }
    port.postMessage({ id, vectors });
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

parentPort?.on('message', (message) => {
  work = work.then(() => handle(message));
});
