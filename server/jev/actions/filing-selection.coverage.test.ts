import { expect, it } from 'vitest';
import type { JevAnswer } from '../../jev.js';
import { sourceSnapshot } from '../stamps.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { filingDecision, refinementQuestionSet } from './filing-selection.js';
import { filingPassages } from './group-passages.js';
import type { ProposedGroup } from './group-topics.js';
import { questionRequestFits } from './question-request-budget.js';

function document(id: string, content: string, group?: string): JevInputDocument {
  const block = { id, title: `Release ${id}`, content, file: `${id}.md`, kind: 'markdown' as const, group,
    incarnation: id, sourceGeneration: 1, metadataRevision: 1, x: 0, y: 0, width: 400, height: 300, links: [] };
  return { canvasId: 'canvas', block, snapshot: sourceSnapshot('workspace', 'canvas', block) };
}
const runbook = '# Rollback\n\nRollback restores the previous release when health checks fail.\n\n## Verify\n\nOperators confirm error rates return to baseline.';
function context(documents: JevInputDocument[]): JevEvaluationContext {
  return { workspaceId: 'workspace', documents, tasks: [], indexes: {}, canvases: [{ id: 'canvas', name: 'Operations' }],
    vocabulary: [], settings: emptyJevWorkspace().settings };
}
function choiceAnswer(probabilities: Record<string, number>): JevAnswer {
  const choice = Object.keys(probabilities).sort((a, b) => probabilities[b] - probabilities[a])[0];
  return { type: 'choice', choice, probabilities, confidence: .9 };
}
function family(peer: JevInputDocument, missing: JevInputDocument): ProposedGroup {
  return { key: 'custom:release_operations', name: 'Release operations', nomination: 'source_family',
    origins: filingPassages(peer).slice(0, 1), candidatePeers: [missing.snapshot, peer.snapshot],
    subjectContext: [{ name: 'Release recovery', passages: filingPassages(peer).slice(1, 2), contextOnly: true }] };
}

it('treats options a placement answer omits as zero probability when choosing the filing group', () => {
  const source = document('source', runbook);
  const groups = [{ key: 'custom:rollback', name: 'Rollback', definition: 'Restoring a previous release' },
    { key: 'custom:billing', name: 'Billing', definition: 'Invoices and payments' }];
  const answers = { place: choiceAnswer({ A: .7 }), gate: choiceAnswer({ A: .9, none: .1 }) };
  expect(filingDecision(context([source]), source, groups, answers)?.group.key).toBe('custom:rollback');
});

it('compares alternatives without a baseline, skipping nominated peers that are no longer in the workspace', () => {
  const source = document('source', runbook);
  const peer = document('peer', runbook, 'custom:release_operations');
  const departed = document('departed', runbook);
  const set = refinementQuestionSet(context([source, peer]), source, undefined, [family(peer, departed)]);
  expect(set.state).toMatchObject({ currentGroup: null, baselineGroup: null });
  expect(set.groups).toHaveLength(1);
  expect(set.groups[0].peerSubjectIds).toEqual(['peer0']);
  expect(set.state.peerSubjects.peer0).toMatchObject({ title: 'Release peer', subject: 'Release recovery', contextOnly: true });
  expect(set.state.groups[0].members).toEqual([{ title: 'Release peer', sections: ['Verify'] }]);
});

it('returns the most compact peer previews when an oversized source outline cannot fit the comparison budget', () => {
  const headings = Array.from({ length: 14 }, (_, index) => `## Step ${index} ${'rollback verification detail '.repeat(150)}`).join('\n\n');
  const source = document('source', `# Rollback\n\n${headings}`, 'custom:operations');
  const peer = document('peer', runbook);
  const current = { key: 'custom:operations', name: 'Operations', definition: 'Running production services' };
  const set = refinementQuestionSet(context([source, peer]), source, current, [family(peer, document('departed', runbook))]);
  expect(set.state).toMatchObject({ currentGroup: 'custom:operations', baselineGroup: 'custom:operations' });
  expect(questionRequestFits(set.state, set.questions, false, 200)).toBe(false);
  const preview = set.state.peerSubjects.peer0;
  expect([preview.title, preview.subject, preview.purpose].map(value => Buffer.byteLength(value))).toEqual([12, 16, 30]);
});
