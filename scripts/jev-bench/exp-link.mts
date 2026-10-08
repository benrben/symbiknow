import { context, jev, save } from './common.mts';
import { linkCases, heldoutLinkCases } from './graph-cases.mts';
import { automaticLinkSet, automaticLinkAssessment } from '../../server/jev/actions/graph.ts';
const run = process.argv[2] ?? 'r1';
const decisionContext = context([], []); decisionContext.confidenceThreshold = .7;
const cases = process.argv.includes('--heldout') ? [...linkCases, ...heldoutLinkCases] : linkCases;
const rows = await Promise.all(cases.map(async ({ pair, truth, name, heldout }) => {
  const set = automaticLinkSet(pair);
  const answers = await jev(set.state, set.questions);
  const finding = automaticLinkAssessment(decisionContext, pair, answers);
  const linked = Boolean(finding.eligible && finding.usefulness >= 1 && finding.relation);
  return { name, truth, heldout, linked, confidence: finding.confidence, relation: finding.relation,
    evidence: finding.evidence.length, usefulness: finding.usefulness, answers };
}));
const positive = rows.filter(row => !row.heldout && row.truth);
const negative = rows.filter(row => !row.heldout && !row.truth);
const heldout = rows.filter(row => row.heldout);
console.log(JSON.stringify({ run, variant: 'actual production automatic link decision', links: `${positive.filter(row => row.linked).length}/${positive.length}`,
  wrong: `${negative.filter(row => row.linked).length}/${negative.length}`, heldout: `${heldout.filter(row => row.linked === row.truth).length}/${heldout.length}`,
  missed: positive.filter(row => !row.linked).map(row => row.name), falseLinks: negative.filter(row => row.linked).map(row => row.name) }));
save(`link-${run}`, rows);
