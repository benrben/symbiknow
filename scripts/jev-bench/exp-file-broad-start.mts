/** Default is a credential-free local payload review. --execute requires separately approved outbound processing. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { file } from '../../server/jev/actions/profile.js';
import { coalesceGroupDefinitions } from '../../server/jev/actions/grouping.js';
import { groupAssessmentSet } from '../../server/jev/actions/group-assessment.js';
import { JEV_MODEL, type JevAnswer, type JevQuestion } from '../../server/jev.js';
import { broadStartContext, broadStartManifest, broadStartReport, broadStartPrerequisites, request, type GroupOwnership } from './file-broad-start.mts';

const [mode = '--prepare', run = 'r1', ownership = 'managed', reviewControl = 'negative'] = process.argv.slice(2);
if (!['--prepare', '--execute'].includes(mode)) throw new Error('Choose --prepare or --execute');
if (!['managed', 'manual', 'pinned'].includes(ownership)) throw new Error('Choose managed, manual, or pinned ownership');
if (!['negative', 'positive'].includes(reviewControl)) throw new Error('Offline review control must be negative or positive');
if (mode === '--execute' && reviewControl !== 'negative') throw new Error('Offline positive controls cannot be used in a provider run');
if (!/^[a-zA-Z0-9_-]+$/.test(run)) throw new Error('Run identifier must contain letters, digits, underscores or hyphens');
let phase: 'profile' | 'label' | 'file' = 'profile';
const rounds: Array<{ phase: string; state: unknown; questions: Record<string, JevQuestion>; answers: Record<string, JevAnswer>; payloadBytes: number }> = [];

function reviewAnswers(questions: Record<string, JevQuestion>, state: unknown): Record<string, JevAnswer> {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: phase === 'profile' && reviewControl === 'positive' ? .99 : 0 }];
    if (question.type !== 'choice') throw new Error('Unexpected review question');
    const comparison = state !== null && typeof state === 'object' && 'currentGroup' in state;
    const positive = reviewControl === 'positive';
    const chosen = phase === 'profile' && positive && Object.hasOwn(question.criteria, 'p0') ? 'p0'
      : comparison && positive && ['place', 'gate'].includes(id) ? 'B'
      : !comparison && ['place', 'gate'].includes(id) ? 'A'
      : positive && id === 'evidence' ? 'p0' : 'none';
    return [id, { type: 'choice', choice: chosen, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === chosen)])) }];
  }));
}

// Preparation uses the actual production call path but its answers are explicitly offline controls, not model measurements.
const input = broadStartContext(ownership as GroupOwnership, async (_key, state, questions) => {
  const answers = reviewAnswers(questions, state);
  rounds.push({ phase, state, questions, answers, payloadBytes: Buffer.byteLength(JSON.stringify({ state, questions })) });
  return answers;
});
const initialManifest = broadStartManifest(input);
let usage: unknown = { calls: 0, input: 0 };
if (mode === '--execute') {
  const provider = await import('./common.mts');
  input.apiKey = provider.providerKey();
  input.decider = async (_key, state, questions) => {
    if (rounds.length >= initialManifest.limits.providerCallCeiling) throw new Error('Broad-start provider call ceiling reached');
    const round = { phase, state, questions, answers: {} as Record<string, JevAnswer>, payloadBytes: Buffer.byteLength(JSON.stringify({ state, questions })) };
    rounds.push(round);
    round.answers = await provider.jev(state, questions);
    return round.answers;
  };
  usage = provider.usage;
}
let prerequisites: Awaited<ReturnType<typeof broadStartPrerequisites>>;
let result: Awaited<ReturnType<typeof file>>;
try {
  prerequisites = await broadStartPrerequisites(input, action => { phase = action; });
  phase = 'file';
  const before = JSON.stringify(input.documents);
  result = { result: { documents: {}, calibration: 1 }, proposals: [] };
  const documents = result.result.documents as Record<string, unknown>;
  const failedProfiles = new Map(prerequisites.failedProfiles.map(failure => [failure.document, failure]));
  for (const source of input.documents) {
    const failure = failedProfiles.get(source.block.id);
    if (failure) {
      documents[source.block.id] = { status: 'failed', phase: 'profile', error: failure.error };
      continue;
    }
    try {
      const evaluated = await file(input, { ...request, blockIds: [source.block.id] });
      documents[source.block.id] = (evaluated.result.documents as Record<string, unknown>)[source.block.id];
      result.proposals.push(...evaluated.proposals);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      documents[source.block.id] = { status: 'failed', phase: 'file', error: error instanceof Error ? error.message : String(error) };
    }
  }
  coalesceGroupDefinitions(result);
  result.result.proposalCount = result.proposals.length;
  if (JSON.stringify(input.documents) !== before) throw new Error('Broad-start evaluation mutated its source documents');
} catch (error) {
  const directory = new URL('./out/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(new URL(`file-broad-start-failed-${run}-${ownership}.json`, directory), JSON.stringify({
    mode, run, ownership, initialManifest, phase, rounds, usage, complete: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 1));
  throw error;
}
const manifest = broadStartManifest(input);
const report = broadStartReport(input, result);
const failedDocuments = report.rows.filter(row => (row.decision as { status?: string })?.status === 'failed');
const assessmentPayloads = mode === '--prepare' ? manifest.candidates.flatMap(row => {
  const document = input.documents.find(document => document.block.id === row.document)!;
  return row.alternatives.map(group => ({ document: row.document, group: group.key,
    ...groupAssessmentSet(input, document, { ...group, reusableTaxonomy: true }, true) }));
}) : [];
const output = { mode, run, model: JEV_MODEL, ownership, reviewControl, initialManifest, manifest, prerequisites, report, rounds, assessmentPayloads, usage,
  failedDocuments, complete: failedDocuments.length === 0,
  measuredProviderResults: mode === '--execute', outboundCalls: mode === '--prepare' ? 0 : rounds.length };
const directory = new URL('./out/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL(`file-broad-start-${mode.slice(2)}-${run}-${ownership}${reviewControl === 'positive' ? '-positive' : ''}.json`, directory), JSON.stringify(output, null, 1));
console.log(JSON.stringify({ mode, run, ownership, documents: input.documents.length,
  callsByPhase: Object.fromEntries(['profile', 'label', 'file'].map(action => [action, rounds.filter(round => round.phase === action).length])),
  alternatives: manifest.candidates.map(row => ({ document: row.document, count: row.alternatives.length })),
  payloadBytes: { maximum: Math.max(0, ...rounds.map(round => round.payloadBytes)), total: rounds.reduce((sum, round) => sum + round.payloadBytes, 0) },
  outboundCalls: output.outboundCalls, complete: output.complete,
  failedDocuments: failedDocuments.map(row => ({ document: row.document, decision: row.decision })), summary: report.summary }));
if (failedDocuments.length) process.exitCode = 1;
