import { context, jev, save } from './common.mts';
import { duplicateCases, heldoutDuplicateCases } from './graph-cases.mts';
import { duplicateQuestionSet, duplicatePairAssessment, deterministicDuplicateMethod } from '../../server/jev/actions/graph.ts';
const run = process.argv[2] ?? 'r1';
const decisionContext = context([], []); decisionContext.confidenceThreshold = .7;
const cases = process.argv.includes('--heldout') ? [...duplicateCases, ...heldoutDuplicateCases] : duplicateCases;
const rows = await Promise.all(cases.map(async ({ pair, truth, name, heldout }) => {
  const deterministic = deterministicDuplicateMethod(pair.source, pair.target);
  if (deterministic) return { name, truth, heldout, pick: 'copy', confidence: 1, method: deterministic };
  const set = duplicateQuestionSet(pair);
  const answers = await jev(set.state, set.questions);
  const finding = duplicatePairAssessment(decisionContext, pair, answers);
  return { name, truth, heldout, pick: finding.eligible ? finding.overlap : 'distinct', confidence: finding.confidence, answers };
}));
const main = rows.filter(row => !row.heldout);
const heldout = rows.filter(row => row.heldout);
console.log(JSON.stringify({ run, variant: 'actual production duplicate decision', right: `${main.filter(row => row.pick === row.truth).length}/${main.length}`,
  olderFound: `${main.filter(row => row.truth === 'older_version' && row.pick !== 'distinct').length}/6`,
  wrong: main.filter(row => row.pick !== row.truth).map(row => ({ name: row.name, pick: row.pick })),
  heldout: `${heldout.filter(row => row.pick === row.truth).length}/${heldout.length}` }));
save(`dup3-${run}`, rows);
