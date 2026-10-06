import { cp, mkdtemp, readFile, writeFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { strict as assert } from 'node:assert';
import { CanvasStore } from '/Users/benreich/allteam/server/storage.ts';
import { JevRuntime } from '/Users/benreich/allteam/server/jev/runtime.ts';
import { JevWorkspaceFiles } from '/Users/benreich/allteam/server/jev/workspace.ts';
import { JevProposalExecutor } from '/Users/benreich/allteam/server/jev/proposals.ts';
import { JevFollowupQueue } from '/Users/benreich/allteam/server/jev/followups.ts';
import { automationPrincipal } from '/Users/benreich/allteam/server/jev/authorization.ts';
import { jevActions, type JevAction, type JevSourceSnapshot, type JevWorkspaceState } from '/Users/benreich/allteam/shared/jev-types.ts';
import type { StoredJevJob } from '/Users/benreich/allteam/server/jev/runtime-queue.ts';
import type { JevAnswer, JevQuestion } from '/Users/benreich/allteam/server/jev.ts';
import type { WorkspaceSummary } from '/Users/benreich/allteam/shared/types.ts';
import { sourceSnapshot } from '/Users/benreich/allteam/server/jev/stamps.ts';
import { resolveSharedQuestionTexts } from '/Users/benreich/allteam/server/jev/actions/question-state-pool.test.helpers.ts';

const sourceRoot = '/Users/benreich/allteam/data', workspaceId = 'acme-team';
const output = '/private/tmp/jev-plan-20261005-fresh-benchmark.json';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const actualLedger = path.join(sourceRoot, 'jev/workspaces', workspaceId, 'state.json');
const sourceDigest = digest(await readFile(actualLedger, 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'jev-all13-transitions-')); await chmod(root, 0o700);
const scope = new AsyncLocalStorage<{ stack: string[]; action?: string }>();
const stages = new Map<string, { count: number; elapsedMs: number }>();
const ioByPhase = new Map<string, { reads: number; readMs: number; writes: number; writeMs: number }>();
interface Completion { action: JevAction; id: string; chain?: string; operation?: string; source?: JevSourceSnapshot; elapsedMs: number }
const jobs = new Map<string, string>(); const completions: Completion[] = [];
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}
function observedJob(value: unknown): value is StoredJevJob {
  return typeof record(record(value)?.request)?.action === 'string';
}
let measured = false, began = 0, targetId = '', checkpointMs: number | undefined, runtime: JevRuntime | undefined;
let providerCalls = 0, providerQuestions = 0, providerRequestMs = 0;
const add = (name: string, ms: number) => { const old = stages.get(name) ?? { count: 0, elapsedMs: 0 }; old.count++; old.elapsedMs += ms; stages.set(name, old); };
function observe(prototype: object, name: string, label: string) {
  const original: unknown = Reflect.get(prototype, name); if (typeof original !== 'function') return;
  Reflect.set(prototype, name, async function (this: unknown, ...args: unknown[]) {
    if (!measured) return Reflect.apply(original, this, args);
    const current = scope.getStore() ?? { stack: [] };
    const job = args.find(observedJob);
    const action = job?.request.action ?? (typeof args[1] === 'string' ? jobs.get(args[1]) : undefined) ?? current.action;
    const begin = performance.now();
    return scope.run({ stack: [...current.stack, label], action }, async () => {
      try {
        const value: unknown = await Reflect.apply(original, this, args);
        if (label === 'workspace.write') {
          const state = args[1] as JevWorkspaceState;
          for (const job of state.jobs) if (job.request.blockIds?.includes(targetId)) jobs.set(job.id, job.request.action);
          const profile = Object.values(state.profiles).find(profile => record(profile.source)?.blockId === targetId);
          if (profile?.organizationContextKey && !profile.organizationFailedContextKey) checkpointMs ??= performance.now() - began;
        }
        if (label === 'runtime.finishJob' && observedJob(args[1])) {
          const completed = args[1];
          completions.push({ action: completed.request.action, id: completed.id, chain: completed.followupKey,
            operation: completed.request.idempotencyKey, source: completed.sources.find(source => source.blockId === targetId), elapsedMs: performance.now() - began });
        }
        return value;
      } finally {
        const elapsed = performance.now() - begin; add(label, elapsed); if (action) add(`${action}:${label}`, elapsed);
        if (['workspace.read', 'workspace.write'].includes(label)) {
          const phase = [...current.stack].reverse().find(name => name.startsWith('runtime.') || name.startsWith('followups.') || name.startsWith('executor.')) ?? 'admission';
          const key = `${action ?? 'admission'}:${phase}`; const old = ioByPhase.get(key) ?? { reads: 0, readMs: 0, writes: 0, writeMs: 0 };
          if (label === 'workspace.read') { old.reads++; old.readMs += elapsed; } else { old.writes++; old.writeMs += elapsed; } ioByPhase.set(key, old);
        }
      }
    });
  });
}
for (const name of ['read', 'write', 'readQueued']) observe(JevWorkspaceFiles.prototype, name, `workspace.${name}`);
for (const name of ['run','takeJob','refreshQueuedSources','jobContext','evaluateJob','finishJob','continueJob','commitAutomatic','fillExecutions']) observe(JevRuntime.prototype, name, `runtime.${name}`);
for (const name of ['applyInside','commit','recoverInside']) observe(JevProposalExecutor.prototype, name, `executor.${name}`);
for (const name of ['queue','resume','complete','context','pendingSource','startRoot','admitStep']) observe(JevFollowupQueue.prototype, name, `followups.${name}`);
for (const name of ['getCanvas','getCanvasBlock','listWorkspaces','listTasks','ensureJevStamps']) observe(CanvasStore.prototype, name, `store.${name}`);
function answer(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: .01 };
  if (question.type === 'score') return { type: 'score', score: 0, confidence: 1,
    probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), Number(i === 0)])) };
  const choice = Object.hasOwn(question.criteria, 'none') ? 'none' : Object.keys(question.criteria)[0];
  return { type: 'choice', choice, confidence: .99, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === choice)])) };
}
const provider = createServer(async (request, response) => {
  const start = performance.now(); let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body) as { questions: Record<string, JevQuestion>; state: { questionTexts?: unknown } }; const questions = resolveSharedQuestionTexts(input.questions, input.state.questionTexts);
  providerCalls++; providerQuestions += Object.keys(questions).length;
  response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, answer(q)])) }));
  providerRequestMs += performance.now() - start;
});
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await cp(sourceRoot, root, { recursive: true, filter: file => file !== path.join(sourceRoot, 'settings.json') });
  const workspacesFile = path.join(root, 'workspaces.json');
  const workspaces = JSON.parse(await readFile(workspacesFile, 'utf8')) as WorkspaceSummary[]; await writeFile(workspacesFile, JSON.stringify(workspaces.filter(w => w.id === workspaceId)));
  const store = new CanvasStore(root); await store.init(); const files = new JevWorkspaceFiles(root); const executor = new JevProposalExecutor(store, files);
  await files.serial(workspaceId, () => executor.recoverInside(workspaceId));
  const local = await files.read(workspaceId); const initialHistory = { receipts: local.receipts.length, proposals: local.proposals.length,
    profiles: Object.keys(local.profiles).length, bytes: (await stat(files.file(workspaceId))).size };
  for (const job of local.jobs) if (['queued','running'].includes(job.state)) job.state = 'cancelled';
  local.settings.paused = true; await files.write(workspaceId, local);
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
  runtime = new JevRuntime(store, { apiKey: 'native-all13-transitions', startTimer: false, fetcher: (_url, init) => fetch(origin, init) }); await runtime.idle();
  const workspace = (await store.listWorkspaces()).find(w => w.id === workspaceId)!;
  const canvas = await store.getCanvas(workspace.canvases[0].id, true, false); const representative = canvas.blocks.find(block => !block.archived && block.content.length > 100)!;
  const fresh = await store.createBlock(canvas.id, { title: representative.title, content: representative.content, x: 317, y: 491 }, automationPrincipal.id); targetId = fresh.id;
  const ready = await files.read(workspaceId); const historyIds = new Set(ready.receipts.map(receipt => receipt.proposalId));
  const receiptHash = digest(JSON.stringify(ready.receipts)); const proposalHash = digest(JSON.stringify(ready.proposals.filter(p => historyIds.has(p.id))));
  ready.settings.paused = false; await files.write(workspaceId, ready);
  const policy = JSON.stringify(ready.settings), beforeRevision = ready.revision;
  const beforeBytes = (await stat(files.file(workspaceId))).size;
  began = performance.now(); measured = true;
  timer = setTimeout(() => runtime?.close(), 180_000);
  const admitted = await runtime.run(workspaceId, { action: 'profile', canvasId: canvas.id, blockIds: [fresh.id], idempotencyKey: 'native-retained-transition' }, automationPrincipal);
  await runtime.idle(); const idleMs = performance.now() - began; measured = false; clearTimeout(timer);
  const final = await new JevWorkspaceFiles(root).read(workspaceId); const profile = final.profiles[`${canvas.id}:${fresh.id}`];
  const completed = final.jobs.filter(job => job.state === 'completed' && job.request.blockIds?.includes(fresh.id));
  const canonical = await store.getCanvasBlock(canvas.id, fresh.id);
  const chain = profile?.organizationKey; const exact = completions.filter(event => event.action === 'profile' ? event.id === admitted.id : event.chain === chain);
  const proof = { all13: jevActions.every(action => exact.some(event => event.action === action)), successfulCheckpoint: /^[a-f0-9]{64}$/.test(String(profile?.organizationContextKey)) && profile?.organizationFailedContextKey === undefined,
    allJobsCompleted: completed.length === 13, policyUnchanged: JSON.stringify(final.settings) === policy,
    sourceUnchanged: JSON.stringify(sourceSnapshot(workspaceId, canvas.id, canonical)) === JSON.stringify(sourceSnapshot(workspaceId, canvas.id, fresh)) && canonical.content === fresh.content && canonical.x === fresh.x && canonical.y === fresh.y,
    historicalReceiptsUnchanged: digest(JSON.stringify(final.receipts.filter(receipt => historyIds.has(receipt.proposalId)))) === receiptHash,
    historicalProposalsUnchanged: digest(JSON.stringify(final.proposals.filter(p => historyIds.has(p.id)))) === proposalHash,
    actualLedgerUnchanged: digest(await readFile(actualLedger, 'utf8')) === sourceDigest };
  const result = { initialHistory, retainedCorpusDocuments: workspace.canvases.length ? (await Promise.all(workspace.canvases.map(c => store.getCanvas(c.id, true, false)))).reduce((sum, c) => sum + c.blocks.length, 0) - 1 : 0,
    beforeBytes, afterBytes: (await stat(files.file(workspaceId))).size, elapsedToCheckpointMs: checkpointMs, idleMs, durableRevisions: final.revision - beforeRevision,
    provider: { kind: 'native-local-loopback', calls: providerCalls, questions: providerQuestions, serverMs: providerRequestMs, realProviderCalls: 0 }, proof,
    stages: Object.fromEntries([...stages].sort()), ioByPhase: Object.fromEntries([...ioByPhase].sort()),
    actionCompletions: exact.map(({ action, elapsedMs }) => ({ action, elapsedMs })),
    caveat: 'Stage timings are inclusive and overlap; do not sum them. Full retained corpus and receipt history are kept; only copied pending jobs are cancelled. Strict unsupported local answers exercise the lowest-provider-latency ALL13 path, including real derived receipts and durable checkpoint. This is a local floor, not a real-provider latency claim.' };
  await writeFile(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify({ output, elapsedToCheckpointMs: checkpointMs, idleMs, durableRevisions: result.durableRevisions, provider: result.provider, proof, workspaceStages: Object.fromEntries([...stages].filter(([name]) => name.startsWith('workspace.'))) }));
  for (const [key, value] of Object.entries(proof)) assert(value, key);
} finally {
  measured = false; if (timer) clearTimeout(timer); provider.closeAllConnections(); await runtime?.shutdown(); await new Promise<void>(resolve => provider.close(() => resolve())); await rm(root, { recursive: true, force: true });
}
