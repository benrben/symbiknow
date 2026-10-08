// Frozen claim benchmark through the shipped HTTP API and native local retrieval.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanvasStore } from '../../server/storage.ts';
import { createApiServer } from '../../server/index.ts';
import { getJevRuntime } from '../../server/jev/runtime.ts';
import { SymbiIndexLifecycle } from '../../server/symbi-index-lifecycle.ts';
import type { SymbiReflexResult } from '../../shared/symbi-contract.ts';
import { atlas, ROOT, providerKey, save, slot } from './common.mts';
import { selectReflexCorpus } from './data/reflex-corpora.mts';
const [run = 'r1', corpus = 'atlas'] = process.argv.slice(2);
const { documents, claims } = selectReflexCorpus(corpus, Object.values(atlas).map(document => ({
  id: document.block.id, title: document.block.title, content: document.block.content,
})));
const modelRoot = path.join(ROOT, 'data/models');
process.env.SYMBI_MODEL_ROOT = modelRoot;

const dataDir = await mkdtemp(path.join(tmpdir(), 'symbi-reflex-benchmark-'));
const store = new CanvasStore(dataDir); await store.init();
const workspace = await store.createWorkspace({ name: 'Frozen claim benchmark' });
const canvas = await store.createCanvas(workspace.id, { name: corpus === 'atlas' ? 'Project Atlas' : `Claim benchmark: ${corpus}` });
const sources = new Map<string, { content: string; contentHash?: string }>();
for (const document of documents) {
  const block = await store.createBlock(canvas.id, { title: document.title, content: document.content });
  sources.set(block.id, { content: block.content, contentHash: block.contentHash });
}
const runtime = getJevRuntime(store);
await runtime.configure(workspace.id, { paused: true, externalProcessing: true },
  { id: 'benchmark-owner', kind: 'user', access: 'write', canConfigure: true });
await runtime.shutdown();
await store.updateSettings({ secrets: { TYPESAFE_API_KEY: providerKey() } });
const index = await SymbiIndexLifecycle.open(store, modelRoot);
await index.close(); // Native reconciliation finishes before any claim is judged.
const { token } = await store.createMcpToken('Frozen claim benchmark', 'read', { allowedCanvasIds: [canvas.id] });
const server = await createApiServer({ dataDir, fetcher: (input, init) => slot(() => fetch(input, init)) });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  const rows = await Promise.all(claims.map(async ({ id, claim, truth }) => {
    const response = await fetch(base + '/api/symbi/reflex', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ claim, canvasId: canvas.id }) });
    if (!response.ok) throw new Error(`Claim benchmark API failed (${response.status})`);
    const result = await response.json() as SymbiReflexResult;
    if (result.coverage.status !== 'ready') throw new Error(`Claim benchmark source coverage is ${result.coverage.status}`);
    if (result.coverage.checkedDocuments !== documents.length || result.coverage.eligibleDocuments !== documents.length)
      throw new Error(`Claim benchmark has incomplete source coverage for ${id}`);
    for (const passage of result.passages) {
      const source = sources.get(passage.blockId);
      if (passage.canvasId !== canvas.id || !source || source.contentHash !== passage.contentHash
        || !Number.isInteger(passage.startOffset) || !Number.isInteger(passage.endOffset)
        || passage.startOffset < 0 || passage.endOffset > source.content.length || passage.endOffset <= passage.startOffset
        || source.content.slice(passage.startOffset, passage.endOffset) !== passage.excerpt)
        throw new Error(`Claim benchmark returned inexact source evidence for ${id}`);
    }
    return { id, heldout: !id.startsWith('atlas-'), claim, truth, verdict: result.verdict, confidence: result.confidence,
      explanation: result.explanation, passages: result.passages.length, evidence: result.passages, coverage: result.coverage, usage: result.providerUsage };
  }));
  const right = rows.filter(row => row.verdict === row.truth).length;
  const heldout = rows.filter(row => row.heldout);
  const report = { variant: 'shipped API', run, corpus, documents: documents.length, right: `${right}/${rows.length}`,
    ...(heldout.length ? { heldout: { right: `${heldout.filter(row => row.verdict === row.truth).length}/${heldout.length}` } } : {}),
    wrong: rows.filter(row => row.verdict !== row.truth).map(row => ({ claim: row.claim, expected: row.truth, actual: row.verdict })),
    providerRequests: rows.reduce((total, row) => total + row.usage.requests, 0) };
  console.log(JSON.stringify(report));
  save(`reflex-${run}`, { report, rows });
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(dataDir, { recursive: true, force: true });
}
