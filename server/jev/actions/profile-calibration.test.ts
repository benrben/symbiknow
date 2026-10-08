import { expect, it, vi } from 'vitest';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevAnswer, JevDecider } from '../../jev.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { logicalIndexResult } from './logical-index.js';
import { profile } from './profile.js';

function fixture(threshold = .7) {
  const document: JevInputDocument = { canvasId: 'canvas', block: { id: 'source', file: 'source.md', title: 'Brand guide', kind: 'markdown',
    x: 0, y: 0, width: 400, height: 300, links: [], content: '# Brand guide\n\n## Typography\n\nUse readable type sizes and consistent spacing.' },
    snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source', incarnation: 'incarnation', sourceGeneration: 1, metadataRevision: 1, contentHash: 'body' } };
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [document], canvases: [{ id: 'canvas', name: 'Guide' }],
    vocabulary: [], tasks: [], settings: emptyJevWorkspace().settings, confidenceThreshold: threshold, apiKey: 'fixture' };
  return { context, document };
}
function answers(raw: number): Record<string, JevAnswer> {
  return { logicalTopic_0: { type: 'noul', noul: raw }, logicalTopicEvidence_0: { type: 'choice', choice: 'p2', confidence: .99,
    probabilities: { p0: 0, p1: 0, p2: 1, none: 0, unknown: 0 } } };
}
it.each([[.29, false], [.3, true]] as const)('calibrates raw topic membership %s at the unchanged 70% slider', (raw, accepted) => {
  const { context, document } = fixture();
  const result = logicalIndexResult(context, document, answers(raw), [{ name: 'Typography', origin: 'source_heading' }]);
  expect(result).toMatchObject({ version: 1, calibration: 1, source: document.snapshot });
  expect(result.topics).toHaveLength(accepted ? 1 : 0);
  if (accepted) expect(result.topics).toEqual([expect.objectContaining({ name: 'Typography', confidence: .7,
    evidence: [expect.objectContaining({ quote: 'Use readable type sizes and consistent spacing.' })] })]);
});
it('keeps the measured boundary below a stricter 90% slider', () => {
  const { context, document } = fixture(.9);
  expect(logicalIndexResult(context, document, answers(.3), [{ name: 'Typography', origin: 'source_heading' }]).topics).toEqual([]);
});
it('asks roles, key passage, entities and logical topics together with an outline containing section names', async () => {
  const { context, document } = fixture();
  const decider = vi.fn<JevDecider>(async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: .3 }];
    if (question.type !== 'choice') throw new Error('Unexpected profile question');
    const picked = id === 'role' ? Object.keys(question.criteria)[0] : 'p2';
    return [id, { type: 'choice', choice: picked, confidence: .99,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === picked)])) }];
  })));
  const result = await profile({ ...context, decider }, { action: 'profile', canvasId: 'canvas', blockIds: ['source'] });
  expect(decider).toHaveBeenCalledOnce();
  expect(decider.mock.calls[0][1]).toMatchObject({ document: { title: document.block.title, sections: ['Typography'] } });
  const questions = decider.mock.calls[0][2];
  expect(questions).toHaveProperty('role'); expect(questions).toHaveProperty('keyPassage'); expect(questions).toHaveProperty('logicalTopic_0');
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'derived', values: { calibration: 1, logicalIndex: { calibration: 1 } } });
});
