import { expect, it } from 'vitest';
import type { JevAnswer } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { calibrated, decisionBoundaries } from './calibration.js';
import { logicalIndexQuestions, logicalIndexResult } from './logical-index.js';

function document(id: string, content: string, tags: string[] = []): JevInputDocument {
  return { canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id,
    incarnation: `inc-${id}`, sourceGeneration: 1, metadataRevision: 2, contentHash: `hash-${id}` },
  block: { id, title: 'Source', content, tags, file: `${id}.md`, kind: 'markdown', x: 12, y: 34, width: 400, height: 300, links: [] } };
}
function context(documents: JevInputDocument[]): JevEvaluationContext {
  return { workspaceId: 'workspace', documents, canvases: [{ id: 'canvas', name: 'Knowledge' }],
    tasks: [], vocabulary: [], settings: emptyJevWorkspace().settings, confidenceThreshold: .85 };
}
function evidence(choice = 'p1'): JevAnswer {
  return { type: 'choice', choice, confidence: .2, probabilities: { [choice]: 1 } };
}
function answers(confidence = .91, selected = 'p1'): Record<string, JevAnswer> {
  return { logicalTopic_0: { type: 'noul', noul: confidence }, logicalTopicEvidence_0: evidence(selected) };
}

it('prioritizes shared broad categories and deterministically bounds normalized unique topics and questions', () => {
  const source = document('one', '# Architecture\nEngineering · Service contracts\n## Architecture\n## Storage\n## Delivery\n## Extra', ['architecture', ' Storage ', 'Manual']);
  const peer = document('two', 'Engineering · Persistence behavior');
  const input = context([source, peer]); const before = structuredClone(input);
  const first = logicalIndexQuestions(input, source);
  expect(first.state.logicalTopicCandidates).toEqual([{ name: 'Engineering' }, { name: 'Architecture' }, { name: 'Storage' },
    { name: 'Delivery' }, { name: 'Extra' }, { name: 'Manual' }, { name: 'Source' }]);
  expect(Object.keys(first.questions)).toHaveLength(14);
  expect(first.questions.logicalTopic_0).toMatchObject({ type: 'noul', instructions: expect.stringContaining('main substantive topic') });
  expect(first).toEqual(logicalIndexQuestions({ ...input, documents: [peer, source] }, source));
  expect(input).toEqual(before);
});

it('caps nominations at sixteen and rejects tiny or overlong normalized names without requiring tags', () => {
  const source = document('bounds', 'Visible context.', ['A', 'X'.repeat(81), ...Array.from({ length: 20 }, (_, index) => `Topic ${index}`)]);
  const candidates = logicalIndexQuestions(context([source]), source).state.logicalTopicCandidates;
  expect(candidates).toEqual(Array.from({ length: 16 }, (_, index) => ({ name: `Topic ${index}` })));
  delete source.block.tags;
  expect(logicalIndexQuestions(context([source]), source).state.logicalTopicCandidates).toEqual([{ name: 'Source' }]);
});

it('orders recurring source categories by independent source count then category name', () => {
  const member = document('member', '# Member\n\n## Beta\n\nBeta covers service behavior.\n\n## Alpha\n\nAlpha covers separate service behavior.');
  const peer = document('peer', '# Peer\n\n## Beta\n\nBeta defines persistence.\n\n## Alpha\n\nAlpha defines requests.');
  const extra = document('extra', '# Extra\n\n## Beta\n\nBeta defines transaction behavior.');
  const names = (logicalIndexQuestions(context([member, peer, extra]), member).state.logicalTopicCandidates as Array<{ name: string }>).map(topic => topic.name);
  expect(names.slice(0, 2)).toEqual(['Beta', 'Alpha']);
  const tied = (logicalIndexQuestions(context([member, peer]), member).state.logicalTopicCandidates as Array<{ name: string }>).map(topic => topic.name);
  expect(tied.slice(0, 2)).toEqual(['Alpha', 'Beta']);
});

it('persists only independently supported topics with exact source identities, offsets and quotes', () => {
  const source = document('one', '# Storage\r\nStorage uses a write journal to preserve recovery.'); const input = context([source]);
  const result = logicalIndexResult(input, source, answers());
  const quote = 'Storage uses a write journal to preserve recovery.';
  expect(result).toEqual({ version: 1, calibration: 1, source: source.snapshot, decisions: [{ name: 'Storage', confidence: calibrated(.91, decisionBoundaries.topicMembership) }], topics: [{ name: 'Storage', confidence: calibrated(.91, decisionBoundaries.topicMembership), evidence: [{ source: source.snapshot,
    start: source.block.content.indexOf(quote), end: source.block.content.length, quote }] }] });
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

it.each([.64, .1, -.01, NaN, Infinity, 1.1])('excludes topics with insufficient or invalid binary support %s even with exact evidence', confidence => {
  const source = document('one', '# Storage\nStorage defines recovery.');
  expect(logicalIndexResult(context([source]), source, answers(confidence))).toMatchObject({ version: 1, calibration: 1, source: source.snapshot, topics: [] });
});

it.each(['none', 'unknown', 'p99'])('excludes semantically supported topics without a valid exact passage (%s)', selected => {
  const source = document('one', '# Storage\nStorage defines recovery.');
  expect(logicalIndexResult(context([source]), source, answers(.99, selected))).toMatchObject({ version: 1, calibration: 1, source: source.snapshot, topics: [] });
});

it('accepts the active threshold boundary but never preserves missing or unvalidated candidates', () => {
  const source = document('one', '# Storage\nStorage defines recovery.\n## Delivery'); const input = context([source]);
  expect(logicalIndexResult(input, source, answers(.85)).topics).toHaveLength(1);
  expect(logicalIndexResult(input, source, {})).toMatchObject({ version: 1, calibration: 1, source: source.snapshot, topics: [] });
  expect(logicalIndexResult(input, source, { logicalTopic_0: { type: 'noul', noul: .99 } })).toMatchObject({ version: 1, calibration: 1, source: source.snapshot, topics: [] });
});

it('uses visible HTML topics and readable questions while retaining exact original HTML evidence', () => {
  const source = document('html', '<html><head><title>Secret title</title></head><body><h1>Storage &amp; Recovery</h1><p>Storage uses <strong>durable journals</strong> for recovery.</p><script>Hidden scripts</script><p hidden>Hidden heading</p></body></html>');
  const input = context([source]); const set = logicalIndexQuestions(input, source);
  expect(set.state.logicalTopicCandidates).toEqual([{ name: 'Storage & Recovery' }, { name: 'Source' }]);
  expect(JSON.stringify(set)).not.toMatch(/Secret title|Hidden scripts|Hidden heading|<strong>/);
  expect(set.questions.logicalTopicEvidence_0).toMatchObject({ criteria: { p1: 'Storage uses durable journals for recovery.' } });
  const result = logicalIndexResult(input, source, answers());
  const quote = 'Storage uses <strong>durable journals</strong> for recovery.';
  expect(result.topics).toEqual([{ name: 'Storage & Recovery', confidence: calibrated(.91, decisionBoundaries.topicMembership), evidence: [{ source: source.snapshot,
    start: source.block.content.indexOf(quote), end: source.block.content.indexOf(quote) + quote.length, quote }] }]);
});

it('normalizes duplicate tags, ignores opaque code and excludes foreign or processing-excluded documents', () => {
  const source = document('one', '```md\n# Hidden code\n```\nVisible prose without a heading.', [' Storage ', 'storage', 'Ｄｅｌｉｖｅｒｙ', 'Delivery']);
  const input = context([source]);
  expect(logicalIndexQuestions(input, source).state.logicalTopicCandidates).toEqual([{ name: 'Storage' }, { name: 'Delivery' }, { name: 'Source' }]);
  source.block.processingExcluded = true;
  expect(logicalIndexQuestions(input, source).questions).toEqual({});
  expect(logicalIndexResult(input, source, answers())).toMatchObject({ version: 1, calibration: 1, source: source.snapshot, topics: [] });
  source.block.processingExcluded = false; source.snapshot.workspaceId = 'private';
  expect(logicalIndexQuestions(input, source).questions).toEqual({});
});


it('nominates the supplied document title for plain text but indexes it only after semantic and exact-evidence validation', () => {
  const source = document('plain', 'Durable journals preserve storage transactions during recovery.');
  source.block.title = 'Storage recovery';
  const input = context([source]);
  expect(logicalIndexQuestions(input, source).state.logicalTopicCandidates).toEqual([{ name: 'Storage recovery' }]);
  expect(logicalIndexResult(input, source, answers(.64, 'p0'))).toMatchObject({ version: 1, calibration: 1, source: source.snapshot, topics: [] });
  expect(logicalIndexResult(input, source, answers(.99, 'none'))).toMatchObject({ version: 1, calibration: 1, source: source.snapshot, topics: [] });
  expect(logicalIndexResult(input, source, answers(.93, 'p0'))).toEqual({ version: 1, calibration: 1, source: source.snapshot, decisions: [{ name: 'Storage recovery', confidence: calibrated(.93, decisionBoundaries.topicMembership) }], topics: [{
    name: 'Storage recovery', confidence: calibrated(.93, decisionBoundaries.topicMembership), evidence: [{ source: source.snapshot, start: 0,
      end: source.block.content.length, quote: source.block.content }],
  }] });
});
