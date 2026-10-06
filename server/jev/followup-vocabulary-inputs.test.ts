import { expect, it } from 'vitest';
import type { JevProposal, JevReceipt, JevVocabularyTerm } from '../../shared/jev-types.js';
import { organizationVocabulary } from './followup-vocabulary-inputs.js';
import { emptyJevWorkspace } from './workspace.js';

const term: JevVocabularyTerm = { id: 'group', kind: 'group', name: 'Release', groupKey: 'custom:release',
  definition: 'Release procedures', aliases: [], state: 'active', version: 1, members: [{ canvasId: 'canvas', blockId: 'source' }] };
function receipt(id: string, after = term, before?: JevVocabularyTerm): JevReceipt {
  return { id, proposalId: id, action: 'file', state: 'applied', automatic: true, createdAt: '2026-10-05', actor: 'automation', sourcesAfter: [],
    before: { kind: 'vocabulary', operation: before ? 'restore' : 'remove', term: before ?? after },
    after: { kind: 'vocabulary', operation: before ? 'promote' : 'define', term: after } };
}
function fixture(receipts = [receipt('definition')], vocabulary = [term]) {
  return { ...emptyJevWorkspace(), receipts, vocabulary };
}

it('omits only exact generated filing definitions without changing retained vocabulary or receipt history', () => {
  const manual = { ...term, id: 'manual' }; const state = fixture([receipt('definition')], [term, manual]);
  const before = structuredClone(state);
  expect(organizationVocabulary(state)).toEqual([manual]); expect(state).toEqual(before);
});

it('reverses successive exact generated updates back to an existing manual candidate', () => {
  const candidate = { ...term, state: 'candidate' as const, version: 1 };
  const promoted = { ...term, version: 2 };
  const extended = { ...promoted, version: 3, members: [...promoted.members, { canvasId: 'canvas', blockId: 'second' }] };
  const state = fixture([receipt('promotion', promoted, candidate), receipt('membership', extended, promoted)], [extended]);
  expect(organizationVocabulary(state)).toEqual([candidate]);
});

it.each(['definition', 'version', 'members', 'aliases'] as const)('preserves a manual %s edit that no longer matches the checked receipt', field => {
  const edited = structuredClone(term);
  if (field === 'definition') edited.definition = 'Manual approval criteria';
  if (field === 'version') edited.version++;
  if (field === 'members') edited.members = [];
  if (field === 'aliases') edited.aliases = ['Manual alias'];
  expect(organizationVocabulary(fixture([receipt('definition')], [edited]))).toEqual([edited]);
});

it.each(['undone', 'manual', 'different-action', 'label', 'different-id'] as const)('does not erase vocabulary through an ineligible %s receipt', kind => {
  const proof = receipt('definition'); const current = structuredClone(term);
  if (kind === 'undone') proof.state = 'undone';
  if (kind === 'manual') proof.automatic = false;
  if (kind === 'different-action') proof.action = 'label';
  if (kind === 'label') { current.kind = 'label'; (proof.after as Extract<JevReceipt['after'], { kind: 'vocabulary' }>).term = current; }
  if (kind === 'different-id') (proof.before as Extract<JevReceipt['before'], { kind: 'vocabulary' }>).term = { ...term, id: 'different' };
  expect(organizationVocabulary(fixture([proof], [current]))).toEqual([current]);
});

it('stops at explicit manual or Undo barriers even when their values match older generated definitions', () => {
  const generated = receipt('generated'); const inverse = receipt('inverse', term, term);
  const proposal: JevProposal = { id: 'inverse', jobId: 'undo:generated', action: 'file', state: 'applied',
    mutation: inverse.after, createdAt: '2026-10-05', title: 'Undo', explanation: 'Explicit checked inverse', sources: [], evidence: [] };
  expect(organizationVocabulary({ ...fixture([generated, inverse]), proposals: [proposal] })).toEqual([term]);
  inverse.automatic = false;
  expect(organizationVocabulary(fixture([generated, inverse]))).toEqual([term]);
});
