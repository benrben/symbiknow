/** Frozen Atlas topics through the application's actual profile/label builders; heldout is opt-in. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atlas, HERE, jev, makeDoc, save, usage, type Doc } from './common.mts';
import { byDoc } from './data/topics2.mts';
import { profileHeldout } from './data/profile-heldout.mts';
import { profileQuestionSet, label } from '../../server/jev/actions/profile.ts';
import { logicalIndexResult, type TopicCandidate } from '../../server/jev/actions/logical-index.ts';
import { emptyJevWorkspace } from '../../server/jev/workspace.ts';
import { contentHash } from '../../server/storage.ts';
import type { JevEvaluationContext, JevInputDocument } from '../../server/jev/actions/context.ts';

const [run = 'r1', phase = 'upgraded', suite = 'atlas'] = process.argv.slice(2);
const baseline = phase === 'baseline';
const measureLabels = !baseline && phase !== 'profile';
type TopicCase = { topic: string; truth: boolean; hard?: boolean };
type Case = { document: JevInputDocument; topics: readonly TopicCase[]; heldout: boolean };
function inputDoc(doc: Doc): JevInputDocument {
  return { canvasId: doc.canvasId, block: { ...doc.block, kind: 'markdown', file: `docs/${doc.block.id}.md`,
    x: 0, y: 0, width: 400, height: 300 }, snapshot: { workspaceId: 'w', canvasId: doc.canvasId,
    blockId: doc.block.id, incarnation: `bench-${doc.block.id}`, sourceGeneration: 1, metadataRevision: 1, contentHash: contentHash(doc.block.content) } };
}
function context(document: JevInputDocument): JevEvaluationContext {
  return { workspaceId: 'w', documents: [document], canvases: [{ id: document.canvasId, name: 'Frozen benchmark' }],
    vocabulary: [], tasks: [], settings: emptyJevWorkspace().settings, confidenceThreshold: .7, apiKey: 'benchmark transport',
    decider: (_key, state, questions) => jev(state, questions) };
}
const cases: Case[] = [...byDoc()].map(([id, topics]) => ({ document: inputDoc(atlas[id]), topics, heldout: false }));
if (suite === 'heldout') for (const item of profileHeldout) {
  const content = readFileSync(path.join(HERE, 'data/profile-heldout', `${item.id}.md`), 'utf8');
  cases.push({ document: inputDoc(makeDoc(`heldout-${item.id}`, content.match(/^#\s+(.+)$/m)?.[1] ?? item.id, content)), topics: item.topics, heldout: true });
}
const rows = await Promise.all(cases.map(async item => {
  const input = context(item.document);
  const candidates: TopicCandidate[] = item.topics.map(topic => ({ name: topic.topic, origin: 'benchmark_answer_key' }));
  const set = profileQuestionSet(input, item.document, candidates);
  const answers = await jev(set.state, set.questions);
  const index = logicalIndexResult(input, item.document, answers, candidates);
  const topics = index.topics as Array<{ name: string; confidence: number }>;
  let tags: string[] = [];
  let labelCalls = 0;
  if (measureLabels) {
    const labeled = await label({ ...input, indexes: { [`${item.document.canvasId}:${item.document.block.id}`]: index },
      decider: (_key, state, questions) => { labelCalls++; return jev(state, questions); } },
    { action: 'label', canvasId: item.document.canvasId, blockIds: [item.document.block.id] });
    tags = labeled.proposals.flatMap(proposal => proposal.mutation.kind === 'document' ? proposal.mutation.patch.tags ?? [] : []);
  }
  return { doc: item.document.block.id, heldout: item.heldout, labelCalls, state: set.state, questions: set.questions, answers,
    cases: item.topics.map((topic, i) => { const answer = answers[`logicalTopic_${i}`];
      return { ...topic, raw: answer?.type === 'noul' ? answer.noul : null,
        calibrated: topics.find(candidate => candidate.name === topic.topic)?.confidence ?? null,
        profileAccepted: topics.some(candidate => candidate.name === topic.topic), labelAccepted: tags.includes(topic.topic) }; }) };
}));
function summarize(heldout: boolean) {
  const selected = rows.filter(row => row.heldout === heldout);
  const checks = selected.flatMap(row => row.cases.map(check => ({ doc: row.doc, ...check })));
  return { suite: heldout ? 'heldout' : 'atlas', documents: selected.length, cases: checks.length,
    profileCorrect: checks.filter(check => check.profileAccepted === check.truth).length,
    ...(!measureLabels ? {} : { labelCorrect: checks.filter(check => check.labelAccepted === check.truth).length,
      labelCalls: selected.reduce((count, row) => count + row.labelCalls, 0) }),
    failures: checks.filter(check => check.profileAccepted !== check.truth || measureLabels && check.labelAccepted !== check.truth) };
}
const report = { action: baseline ? 'baseline-profile' : measureLabels ? 'profile+label' : 'profile', run, phase, model: 'jev-1.13.0',
  suites: [summarize(false), ...(suite === 'heldout' ? [summarize(true)] : [])], usage: { ...usage }, rows };
save(`profile-${run}`, report);
for (const summary of report.suites) console.log(JSON.stringify({ ...summary, run, phase }));
