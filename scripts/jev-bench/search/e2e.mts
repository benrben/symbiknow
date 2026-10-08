/** Optional real API search benchmark; this runner never changes ask_symbi. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanvasStore } from '../../../server/storage.ts';
import { createApiServer } from '../../../server/index.ts';
import { getJevRuntime } from '../../../server/jev/runtime.ts';
import { SymbiIndexLifecycle } from '../../../server/symbi-index-lifecycle.ts';
import type { AskSymbiResult } from '../../../shared/symbi-contract.ts';
import { HERE, ROOT, providerKey, save, slot } from '../common.mts';
import { queries } from './queries.mjs';
import { queries2 } from './queries2.mjs';

const label = process.argv[2] ?? 'e2e';
const modelRoot = path.join(ROOT, 'data/models');
process.env.SYMBI_MODEL_ROOT = modelRoot;
const files = ['README.md', 'system-map.html', 'architecture.md', 'data-model.md', 'safe-collaboration.md', 'symbi-reflex.md',
  'search-and-brain-tools.md', 'mcp-and-api.md', 'assistant-and-research.md', 'operations.md', 'plan-status.md',
  'security-and-access.md', 'document-operations.md', 'canvas-ui.md', 'chat-internals.md', 'brand-and-ui.md',
  'sdk-and-webmcp.md', 'testing.md', 'errors.md', 'reflex-internals.md', 'history.md'];
const dataDir = await mkdtemp(path.join(tmpdir(), 'symbi-search-benchmark-'));
const store = new CanvasStore(dataDir);
await store.init();
const workspace = await store.createWorkspace({ name: 'Frozen Atlas benchmark' });
const canvas = await store.createCanvas(workspace.id, { name: 'Project Atlas' });
const blockDoc = new Map<string, string>();
for (const file of files) {
  const content = await readFile(path.join(HERE, 'data/atlas', file), 'utf8');
  const title = content.match(/^#\s+(.+)$/m)?.[1] ?? file;
  const block = await store.createBlock(canvas.id, { title, content });
  blockDoc.set(block.id, file.replace(/\.(md|html)$/, ''));
}
const runtime = getJevRuntime(store);
await runtime.configure(workspace.id, { paused: true, externalProcessing: true },
  { id: 'benchmark-owner', kind: 'user', access: 'write', canConfigure: true });
await runtime.shutdown();
await store.updateSettings({ secrets: { TYPESAFE_API_KEY: providerKey() } });
const index = await SymbiIndexLifecycle.open(store, modelRoot);
await index.close();
const { token } = await store.createMcpToken('Frozen Atlas search benchmark', 'read', { allowedCanvasIds: [canvas.id] });
const server = await createApiServer({ dataDir, fetcher: (input, init) => slot(() => fetch(input, init)) });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Search benchmark server failed to listen');
const base = `http://127.0.0.1:${address.port}`;
try {
  const cases = [...queries, ...queries2];
  const rows = await Promise.all(cases.map(async item => {
    const start = Date.now();
    const response = await fetch(base + '/api/symbi/ask', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: item.q, mode: 'combined', canvasId: canvas.id }) });
    if (!response.ok) throw new Error(`Search benchmark API failed (${response.status})`);
    const result = await response.json() as AskSymbiResult;
    return { id: item.id, rel: item.rel as string[], ms: Date.now() - start,
      docs: result.matches.flatMap(match => match.blockId ? [blockDoc.get(match.blockId) ?? match.blockId] : []),
      coverage: result.coverage, usage: result.providerUsage };
  }));
  const positive = rows.filter(row => row.rel.length);
  const negative = rows.filter(row => !row.rel.length);
  const timings = rows.map(row => row.ms).sort((left, right) => left - right);
  const report = { label, first: `${positive.filter(row => row.rel.includes(row.docs[0])).length}/${positive.length}`,
    noAnswerEmpty: `${negative.filter(row => !row.docs.length).length}/${negative.length}`,
    misses: positive.filter(row => !row.rel.includes(row.docs[0])).map(row => row.id),
    falseHits: negative.filter(row => row.docs.length).map(row => row.id),
    medianMs: timings[Math.floor(timings.length / 2)], p90Ms: timings[Math.floor(timings.length * .9)] };
  save(`search-${label}`, { report, rows });
  console.log(JSON.stringify(report));
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(dataDir, { recursive: true, force: true });
}
