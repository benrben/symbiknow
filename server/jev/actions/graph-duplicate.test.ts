import { expect, it, vi } from 'vitest';
import { jevActions } from '../../../shared/jev-types.js';
import type { JevAnswer, ChoiceAnswer } from '../../jev.js';
import { evaluateJevAction, type JevEvaluationContext, type JevInputDocument } from '../actions.js';
import { duplicateQuestionSet, duplicatePairAssessment, type Pair } from './graph.js';

function document(id: string, content: string): JevInputDocument {
  return { canvasId: 'canvas', block: { id, title: id, content, file: `${id}.md`, kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [] },
    snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id, incarnation: `inc-${id}`, sourceGeneration: 1, metadataRevision: 1, contentHash: id } };
}
const source = document('source', '# Source\n\nInstall the release.\n\n## Recovery\n\nRestore the tagged build.');
const target = document('target', '# Target\n\nA documented older release.\n\nInstall the release.');
const pair: Pair = { source, target, hypothesis: 'substantially the same knowledge' };
function answer(copy: number, version: number, distinct: number): Record<string, JevAnswer> {
  const choice = copy >= version ? 'copy' : 'version';
  return { overlap: { type: 'choice', choice: distinct > Math.max(copy, version) ? 'distinct' : choice,
    probabilities: { copy, version, distinct }, confidence: 0.2 } satisfies ChoiceAnswer };
}
function context(answers = answer(.1, .85, .05), threshold = .7): JevEvaluationContext {
  return { workspaceId: 'workspace', documents: [source, target], canvases: [{ id: 'canvas', name: 'Releases' }], tasks: [], vocabulary: [],
    retrievedNeighbors: { 'canvas:source': ['canvas:target'] },
    confidenceThreshold: threshold, apiKey: 'unit-boundary', decider: vi.fn(async () => answers),
    settings: { paused: false, externalProcessing: true, people: [], schedules: [],
      modes: Object.fromEntries(jevActions.map(action => [action, 'auto'])) as JevEvaluationContext['settings']['modes'] } };
}

it('asks one whole-document overlap choice with titles, section lists, and bounded source passages', () => {
  const set = duplicateQuestionSet(pair);
  expect(Object.keys(set.questions)).toEqual(['overlap']);
  expect(Object.keys(set.questions.overlap.criteria)).toEqual(['copy', 'version', 'distinct']);
  expect(set.state.source).toMatchObject({ title: 'source', sections: ['Recovery'] });
  expect(set.state.target).toMatchObject({ title: 'target', sections: [] });
  expect((set.state.source.passages as unknown[]).length).toBeLessThanOrEqual(8);
});

it.each([
  ['copy', .8, .1, .1, true, 'copy'],
  ['older', .1, .8, .1, true, 'older_version'],
  ['distinct', .1, .1, .8, false, 'copy'],
  ['below boundary', .1, .39, .51, false, 'older_version'],
  ['at boundary', .1, .4, .5, true, 'older_version'],
] as const)('judges %s from combined overlap independently of the split choice confidence', (_name, copy, version, distinct, eligible, kind) => {
  const finding = duplicatePairAssessment(context(), pair, answer(copy, version, distinct));
  expect(finding.eligible).toBe(eligible);
  expect(finding.overlap).toBe(kind);
  expect(finding.calibration).toBe(1);
});

it('retains the configured confidence slider and fails closed on absent or non-choice overlap answers', () => {
  expect(duplicatePairAssessment(context(undefined, .1), pair, answer(.1, .39, .51)).eligible).toBe(false);
  expect(duplicatePairAssessment(context(undefined, .1), pair, answer(.1, .4, .5)).eligible).toBe(true);
  expect(duplicatePairAssessment(context(undefined, .9), pair, answer(.1, .71, .19)).eligible).toBe(false);
  expect(duplicatePairAssessment(context(), pair, {}).eligible).toBe(false);
  expect(duplicatePairAssessment(context(), pair, { overlap: { type: 'noul', noul: 1 } }).eligible).toBe(false);
});

it('uses a shared body quote with real offsets or one body quote from each reworded source', () => {
  const shared = duplicatePairAssessment(context(), pair, answer(.8, .1, .1));
  expect(shared.evidence.map(item => item.quote)).toEqual(['Install the release.', 'Install the release.']);
  for (const evidence of shared.evidence) {
    const document = [source, target].find(item => item.block.id === evidence.source.blockId)!;
    expect(document.block.content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
  }
  const rewritten = { ...pair, target: document('rewritten', '# Rewrite\n\nDeploy the approved release package.') };
  expect(duplicatePairAssessment(context(), rewritten, answer(.8, .1, .1)).evidence.map(item => item.quote))
    .toEqual(['Install the release.', 'Deploy the approved release package.']);
  expect(duplicatePairAssessment(context(), { ...pair, target: document('empty', '# Heading only') }, answer(.8, .1, .1)).eligible).toBe(false);
  const html = { source: document('html-source', '<h1>Shared heading</h1><p>Install the release.</p>'),
    target: document('html-target', '<h2>Shared heading</h2><p>Ship the approved build.</p>'), hypothesis: pair.hypothesis };
  const evidence = duplicatePairAssessment(context(), html, answer(.8, .1, .1)).evidence;
  expect(evidence.map(item => item.quote)).toEqual(['Install the release.', 'Ship the approved build.']);
  for (const item of evidence) {
    const document = item.source.blockId === 'html-source' ? html.source : html.target;
    expect(document.block.content.slice(item.start, item.end)).toBe(item.quote);
  }
  expect(duplicatePairAssessment(context(), { ...html, target: document('html-empty', '<h1>Shared heading</h1>') }, answer(.8, .1, .1)).eligible).toBe(false);
  const headingCollision = { ...pair, target: document('collision', '# Install the release.\n\nInstall the release.') };
  const sharedBody = duplicatePairAssessment(context(), headingCollision, answer(.8, .1, .1)).evidence[1];
  expect(sharedBody.start).toBe(headingCollision.target.block.content.lastIndexOf('Install the release.'));
  const headingOnlyCollision = { ...pair, target: document('collision-only', '<h1>Install the release.</h1>') };
  expect(duplicatePairAssessment(context(), headingOnlyCollision, answer(.8, .1, .1)).eligible).toBe(false);
});

it('records calibrated duplicate kind and evidence from one real evaluator decision without editing documents', async () => {
  const input = context(); input.settings.confidenceThresholds = { flag_duplicate: .7 };
  const before = structuredClone(input.documents);
  const result = await evaluateJevAction(input, { action: 'flag_duplicate', canvasId: 'canvas', blockIds: ['source'] });
  expect(input.decider).toHaveBeenCalledTimes(1);
  expect(result.result).toMatchObject({ calibration: 1, findings: [{ kind: 'duplicate', overlap: 'older_version', calibration: 1 }] });
  expect(result.proposals[0]).toMatchObject({ title: 'Possible older version', mutation: { kind: 'derived', values: { overlap: 'older_version', calibration: 1 } } });
  expect(result.proposals[0].confidence).toBeGreaterThan(.7);
  expect(input.documents).toEqual(before);
});

it('preserves the deterministic copy path without a model request', async () => {
  const input = context(); input.documents[1] = document('copy', source.block.content.replace('# Source', '# Copy'));
  const result = await evaluateJevAction(input, { action: 'flag_duplicate', canvasId: 'canvas', blockIds: ['source'] });
  expect(input.decider).not.toHaveBeenCalled();
  expect(result.result.findings).toMatchObject([{ overlap: 'copy', confidence: 1, method: 'substantive_content' }]);
  expect(result.proposals[0].title).toBe('Possible copy');
});
