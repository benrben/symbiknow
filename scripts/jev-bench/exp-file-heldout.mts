/** Synthetic heldout input: obtain user approval for these texts before external execution. */
import { createHash } from 'node:crypto';
import { file } from '../../server/jev/actions/profile.ts';
import { JEV_MODEL } from '../../server/jev.ts';
import { jev, providerKey, save, usage } from './common.mts';
import { filingHeldout, type HeldoutFilingCase } from './data/filing-heldout.mts';
import { filingHeldoutContext } from './filing-heldout-context.mts';

const run = process.argv[2] ?? 'heldout-r1';
async function evaluate(item: HeldoutFilingCase) {
  const input = filingHeldoutContext(item, (_key, state, questions) => jev(state, questions), providerKey());
  const source = input.documents[0];
  const result = await file(input, { action: 'file', canvasId: item.id, blockIds: [source.block.id] });
  const placements = result.proposals.flatMap(proposal => {
    const mutation = proposal.mutation;
    if (mutation.kind !== 'document' || mutation.blockId !== source.block.id || !mutation.patch.group) return [];
    return [{ group: mutation.patch.group, confidences: proposal.decisionConfidences,
      evidence: proposal.evidence.map(passage => ({ start: passage.start, end: passage.end, quote: passage.quote })) }];
  });
  const supplied = new Set(item.groups.map(group => group.id));
  const existing = placements.filter(placement => supplied.has(placement.group));
  const bootstrapped = placements.filter(placement => !supplied.has(placement.group));
  const good = item.expectedGroup === null ? existing.length === 0
    : existing.length === 1 && existing[0].group === item.expectedGroup && bootstrapped.length === 0;
  return { caseId: item.id, domain: item.domain, expectedExistingGroup: item.expectedGroup, good,
    existingPlacements: existing, bootstrapPlacements: bootstrapped,
    documentUnchanged: source.block.group === undefined, proposals: result.proposals.length };
}
const rows = await Promise.all(filingHeldout.map(evaluate));
const positive = rows.filter(row => row.expectedExistingGroup !== null), negative = rows.filter(row => row.expectedExistingGroup === null);
const report = { variant: 'shipped file()', model: JEV_MODEL, run,
  fixtureSha256: createHash('sha256').update(JSON.stringify(filingHeldout)).digest('hex'),
  placements: `${positive.filter(row => row.good).length}/${positive.length}`,
  offTopicExistingGroupErrors: `${negative.filter(row => !row.good).length}/${negative.length}`,
  bootstrapCases: negative.filter(row => row.bootstrapPlacements.length > 0).map(row => row.caseId),
  documentMutationsDuringEvaluation: rows.filter(row => !row.documentUnchanged).map(row => row.caseId),
  failed: rows.filter(row => !row.good).map(row => row.caseId), usage };
console.log(JSON.stringify(report));
save(`filing-heldout-${run}`, { report, rows });
