/** Credential-free preparation by default; approved frozen Atlas execution requires --execute. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decideWithJev, JEV_MODEL, type JevAnswer, type JevQuestion } from '../../server/jev.js';
import { atlasIds } from './file-broad-start.mts';
import { groups, alternates } from './data/placement-families.mjs';
import { runCanonicalFilingQueue, type CanonicalPhase } from './file-canonical-queue.mts';
import { resolveSharedQuestionTexts } from '../../server/jev/actions/question-state-pool.test.helpers.js';

const [mode = '--prepare', label = 'r1'] = process.argv.slice(2);
if (!['--prepare', '--execute'].includes(mode) || !/^[A-Za-z0-9_-]+$/.test(label)) throw new Error('Use --prepare|--execute LABEL');
const sources = atlasIds.map(id => {
  const content = readFileSync(new URL(`./data/atlas/${id}.md`, import.meta.url), 'utf8');
  return { id, title: content.match(/^#\s+(.+)$/m)?.[1] ?? id, content };
});
let phase: CanonicalPhase = 'profile'; let document: string | undefined;
const rounds: Array<{ phase: CanonicalPhase; document?: string; state: unknown; questions: Record<string, JevQuestion>;
  answers: Record<string, JevAnswer>; payloadBytes: number }> = [];
let usage: unknown = { calls: 0, input: 0 };
let execute: ((state: unknown, questions: Record<string, JevQuestion>) => Promise<Record<string, JevAnswer>>) | undefined;
let apiKey = 'offline-canonical-filing';
if (mode === '--execute') {
  const provider = await import('./common.mts'); apiKey = provider.providerKey(); execute = provider.jev; usage = provider.usage;
}
function abstain(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: 0 };
  if (question.type !== 'choice') throw new Error('Unexpected canonical filing score question');
  const choice = Object.hasOwn(question.criteria, 'none') ? 'none' : Object.keys(question.criteria)[0];
  return { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === choice)])) };
}
const report = await runCanonicalFilingQueue({ sources, apiKey, phase: (next, source) => { phase = next; document = source; },
  decider: async (_key, state, questions) => {
    if (phase === 'startup') throw new Error('Unexpected startup provider call');
    if (rounds.length >= 200) throw new Error('Canonical filing logical call ceiling reached');
    const round = { phase, document, state, questions, answers: {} as Record<string, JevAnswer>, payloadBytes: Buffer.byteLength(JSON.stringify({ state, questions })) };
    rounds.push(round);
    round.answers = execute ? await execute(state, questions) : await decideWithJev(apiKey, state, questions, async () => Response.json({
      answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
        abstain(resolveSharedQuestionTexts(question, (state as Record<string, unknown>).questionTexts))])),
    }), { maxRetries: 0 });
    return round.answers;
  } });
const output = { mode, label, model: JEV_MODEL, corpus: 'frozen Project Atlas Markdown corpus',
  corpusSha256: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
  frozenFamilyKeys: groups, acceptableAlternates: alternates, unscoredDocuments: ['README'],
  limits: { logicalCalls: 200, providerConcurrency: 2, retriesPerCall: 2 },
  measuredProviderResults: mode === '--execute', outboundCalls: mode === '--execute' ? rounds.length : 0,
  rounds, usage, report };
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./out/file-canonical-queue-${mode.slice(2)}-${label}.json`, import.meta.url), JSON.stringify(output, null, 1));
console.log(JSON.stringify({ mode, label, complete: report.complete, documents: report.rows.length,
  callsByPhase: Object.fromEntries(['profile', 'label', 'file', 'startup'].map(action => [action, rounds.filter(round => round.phase === action).length])),
  payloadBytes: { maximum: Math.max(0, ...rounds.map(round => round.payloadBytes)), total: rounds.reduce((sum, round) => sum + round.payloadBytes, 0) },
  finalGroups: report.rawFinalNativeGroups, failures: report.failures, receipts: report.receipts.length,
  projectionOnly: false, automaticDocumentPipeline: false }));
if (!report.complete) process.exitCode = 1;
