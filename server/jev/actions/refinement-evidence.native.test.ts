import { expect, it } from 'vitest';
import type { JevPassage } from '../../../shared/jev-types.js';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../../jev.js';
import { sourceSnapshot } from '../stamps.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { filingPassages } from './group-passages.js';
import { assessGroupRefinement } from './grouping.js';
import type { ProposedGroup } from './group-topics.js';
import { questionRequestFits } from './question-request-budget.js';

type Wire = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
function source(id: string): JevInputDocument {
  const prose = '身份认证验证账户权限并保护会话凭据。'.repeat(45);
  const block = { id, title: `身份认证指南 ${id}`, file: `${id}.md`, kind: 'markdown' as const,
    content: '# 身份认证\n\n' + Array.from({ length: 14 }, (_, index) => `${index}: ${prose}`).join('\n\n'),
    group: 'custom:engineering', incarnation: id, sourceGeneration: 1, metadataRevision: 1,
    x: 0, y: 0, width: 400, height: 300, links: [],
    jevOwnership: { managed: ['group'], pins: [], removedLabels: [], removedLinks: [] } };
  return { canvasId: 'canvas', block, snapshot: sourceSnapshot('workspace', 'canvas', block) };
}
function answer(id: string, question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: id === 'independent' ? .1 : .99 };
  if (question.type !== 'choice') throw new Error('Unexpected refinement decision');
  return { type: 'choice', choice: 'p1', confidence: .99,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === 'p1')])) };
}
function fixture(selective: boolean, rejectedPeer = false) {
  const documents = ['member', 'peer1', 'peer2', 'peer3', 'peer4'].map(source);
  const [member, ...peers] = documents; const calls: Wire[] = [];
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents, canvases: [{ id: 'canvas', name: 'Knowledge' }],
    tasks: [], vocabulary: [], settings: emptyJevWorkspace().settings, apiKey: 'offline-refinement', selectiveGroupAssessment: selective,
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as Wire;
      expect(questionRequestFits(wire.state, wire.questions, false)).toBe(true); calls.push(wire);
      return Response.json({ answers: Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
        const value = rejectedPeer && id.startsWith('purpose_') && (wire.state.source as { id: string }).id !== 'member'
          ? { type: 'noul', noul: .69 } : answer(id, question);
        return [id, value];
      })) });
    }, options) };
  const group: ProposedGroup = { name: '身份认证', key: 'custom:authentication', nomination: 'source_subject',
    origins: filingPassages(member).slice(1, 5), candidatePeers: peers.map(peer => peer.snapshot),
    subjectContext: peers.map(peer => ({ name: peer.block.title, passages: filingPassages(peer).slice(1, 3), contextOnly: true })) };
  return { context, member, peers, calls, group };
}
function ownProof(proof: JevPassage, member: JevInputDocument) {
  expect(proof.source).toEqual(member.snapshot);
  expect(proof.quote.length).toBe(600);
  expect(member.block.content.slice(proof.start, proof.end)).toBe(proof.quote);
}

it.each([false, true])('checks complete multibyte singleton evidence through independence and shared fallback without413 (selective=%s)', async selective => {
  const f = fixture(selective); const before = structuredClone(f.group);
  const result = await assessGroupRefinement(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['member'] }, f.member, f.group, .99);
  const membership = result.proposals.find(proposal => proposal.mutation.kind === 'document')!;
  const definition = result.proposals.find(proposal => proposal.mutation.kind === 'vocabulary')!;
  expect(membership.sources).toEqual([f.member.snapshot]);
  ownProof(membership.evidence[0], f.member);
  expect(definition.sources).toEqual(expect.arrayContaining([f.member.snapshot, f.peers[0].snapshot]));
  ownProof(definition.evidence.find(proof => proof.source.blockId === 'peer1')!, f.peers[0]);
  expect(f.calls[0].state.peerSubjects).toEqual([expect.objectContaining({ id: 'peer1' })]);
  expect(f.calls[0].state.peerSubjects).toEqual([expect.objectContaining({ passages: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('身份认证验证账户权限') })]) })]);
  expect(f.calls).toHaveLength(5);
  expect(Object.keys(f.calls[1].questions)).toEqual(['evidence']);
  expect(Object.keys(f.calls[2].questions)).toEqual(['coherent', 'purpose_1']);
  expect(Object.keys(f.calls[3].questions)).toEqual(['evidence']);
  expect(Object.keys(f.calls[4].questions)).toEqual(['purpose_1']);
  expect(f.calls[2].state.localEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ quote: membership.evidence[0].quote })]));
  const selected = f.calls[2].state.selectedGroup as { origins: JevPassage[]; reusableTaxonomy: boolean };
  expect(selected.origins.map(proof => proof.quote)).toEqual(f.group.origins.map(proof => proof.quote));
  expect(selected.reusableTaxonomy).toBe(true);
  expect(selected).not.toHaveProperty('candidatePeers');
  expect(selected).not.toHaveProperty('subjectContext');
  const peerScope = f.calls[4].state.selectedGroup as { definition?: string };
  expect((selected as typeof selected & { definition?: string }).definition).toBe(peerScope.definition);
  expect(peerScope.definition).toContain('身份认证');
  expect(peerScope.definition).not.toContain(f.group.origins[0].quote);
  expect(selected).toHaveProperty('originsRole', 'nomination_examples');
  expect(definition.mutation).toMatchObject({ term: { definition: expect.stringContaining(membership.evidence[0].quote) } });
  expect(f.group).toEqual(before);
});

it('keeps an explicit narrow definition identical for own and peer checks and rejects peer purpose below the unchanged cutoff', async () => {
  const f = fixture(true, true);
  const restriction = 'Only documents about hardware-backed identity credentials. Exclude general software sessions and API transport.';
  f.group.definition = restriction;
  const result = await assessGroupRefinement(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['member'] }, f.member, f.group, .99);
  expect(result.proposals).toEqual([]);
  const definitions = f.calls.filter(call => Object.hasOwn(call.state, 'selectedGroup'))
    .map(call => (call.state.selectedGroup as { definition: string }).definition);
  expect(definitions.length).toBeGreaterThan(2);
  expect(definitions.every(definition => definition === restriction)).toBe(true);
  expect(f.group.definition).toBe(restriction);
  expect(f.calls.filter(call => (call.state.source as { id?: string })?.id?.startsWith('peer')
    && Object.keys(call.questions).some(id => id.startsWith('purpose_')))).toHaveLength(4);
});
