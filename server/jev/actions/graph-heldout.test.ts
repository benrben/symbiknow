import { expect, it } from 'vitest';
import { heldoutDuplicates, heldoutLinks, type HeldoutDocument } from '../../../scripts/jev-bench/graph-heldout.mjs';
import type { JevAnswer } from '../../jev.js';
import { duplicateQuestionSet, duplicatePairAssessment, deterministicDuplicateMethod, automaticLinkSet, automaticLinkAssessment, type Pair } from './graph.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';

function document(raw: HeldoutDocument, id: string): JevInputDocument {
  return { canvasId: 'heldout', block: { id, title: raw.title, content: raw.body, file: `${id}.md`, kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [] },
    snapshot: { workspaceId: 'test', canvasId: 'heldout', blockId: id, incarnation: id, sourceGeneration: 1, metadataRevision: 1, contentHash: id } };
}
function pair(source: HeldoutDocument, target: HeldoutDocument): Pair {
  return { source: document(source, 'source'), target: document(target, 'target'), hypothesis: 'useful supported relationship' };
}
const context = { confidenceThreshold: .7 } as JevEvaluationContext;
it('freezes at least ten independent duplicate cases with all three truth classes and real source passages', () => {
  expect(heldoutDuplicates).toHaveLength(12);
  for (const raw of heldoutDuplicates) {
    const input = pair(raw.source, raw.target);
    const questions = duplicateQuestionSet(input).questions;
    expect(Object.keys(questions)).toEqual(['overlap']);
    const choice = raw.truth === 'older_version' ? 'version' : raw.truth;
    const answers: Record<string, JevAnswer> = { overlap: { type: 'choice', choice, confidence: .1,
      probabilities: Object.fromEntries(['copy', 'version', 'distinct'].map(key => [key, Number(key === choice)])) } };
    const finding = duplicatePairAssessment(context, input, answers);
    expect(finding.eligible ? finding.overlap : 'distinct').toBe(raw.truth);
    expect(Boolean(deterministicDuplicateMethod(input.source, input.target))).toBe(raw.truth === 'copy');
    for (const evidence of finding.evidence) {
      const source = evidence.source.blockId === 'source' ? input.source : input.target;
      expect(source.block.content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
    }
  }
});
it('freezes at least ten independent link cases with balanced truth and exact body evidence', () => {
  expect(heldoutLinks).toHaveLength(12);
  expect(heldoutLinks.filter(item => item.truth)).toHaveLength(6);
  for (const raw of heldoutLinks) {
    const input = pair(raw.source, raw.target);
    const set = automaticLinkSet(input);
    const evidence = (choice: string): JevAnswer => ({ type: 'choice', choice, confidence: .1, probabilities: { [choice]: 1 } });
    const finding = automaticLinkAssessment(context, input, { supported: { type: 'noul', noul: raw.truth ? .9 : .1 },
      sourceEvidence: evidence('p1'), targetEvidence: evidence('p1'), relation: evidence(raw.truth ? 'related' : 'none') });
    expect(finding.eligible).toBe(raw.truth);
    expect(set.state.source.title).toBe(raw.source.title);
    expect(set.questions.supported.instructions).toContain('useful context');
  }
});
