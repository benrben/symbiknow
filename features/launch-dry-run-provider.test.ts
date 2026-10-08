import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { acceptanceReflexProvider } from './acceptance-reflex-provider.js';
import { launchDryRunDecider } from './launch-dry-run-provider.js';
import { filingQuestionSet, filingEvidenceQuestionSet } from '../server/jev/actions/filing-selection.js';
import { homeQuestionSet, homeEvidenceQuestionSet } from '../server/jev/actions/home-selection.js';
import type { JevEvaluationContext, JevInputDocument } from '../server/jev/actions/context.js';

function source(name: string): JevInputDocument {
  const content = readFileSync(`features/fixtures/launch-dry-run/${name}.md`, 'utf8');
  return { canvasId: 'current', block: { id: name, title: name, content, file: `${name}.md`, kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [] },
    snapshot: { workspaceId: 'test', canvasId: 'current', blockId: name, incarnation: name, sourceGeneration: 1, metadataRevision: 1, contentHash: name } };
}
const groups = ['Security', 'Pricing', 'Release'].map(name => ({ key: `custom:${name.toLowerCase()}`, name, definition: `${name} source documents` }));
const context = { documents: [], canvases: [] } as unknown as JevEvaluationContext;
it('places all eight frozen launch documents by their main subject using the shipped letter choices and a separate exact-evidence set', async () => {
  const files = ['sso-security-review', 'pen-test-findings', 'access-control-policy', 'pricing-tiers-decision', 'pricing-page-copy', 'launch-blockers', 'rollback-runbook', 'rollback-steps-copy'];
  const expected = ['A', 'A', 'A', 'B', 'B', 'C', 'C', 'C'];
  for (const [index, name] of files.entries()) {
    const document = source(name);
    const set = filingQuestionSet(context, document, groups, false);
    const answers = await launchDryRunDecider('local-oracle', set.state, set.questions);
    expect(answers).toMatchObject({ place: { choice: expected[index] }, gate: { choice: expected[index] } });
    const evidence = filingEvidenceQuestionSet(document, groups[index < 3 ? 0 : index < 5 ? 1 : 2]);
    const checked = await launchDryRunDecider('local-oracle', evidence.state, evidence.questions);
    expect(checked.evidence.type).toBe('choice');
    if (checked.evidence.type !== 'choice') throw new Error('Expected evidence choice');
    expect(checked.evidence.choice).not.toBe('none');
  }
});
it('selects a supported home canvas from its document examples and checks the later source evidence', async () => {
  const document = source('sso-security-review');
  const peer = { ...source('access-control-policy'), canvasId: 'security' };
  const input = { ...context, documents: [document, peer], canvases: [{ id: 'current', name: 'Inbox' }, { id: 'security', name: 'Security references' }] };
  const set = homeQuestionSet(input, document, false);
  expect(await launchDryRunDecider('local-oracle', set.state, set.questions)).toMatchObject({ place: { choice: 'B' }, gate: { choice: 'B' } });
  const evidence = homeEvidenceQuestionSet(document, set.canvases[1]);
  const result = await launchDryRunDecider('local-oracle', evidence.state, evidence.questions);
  expect(result.evidence).toMatchObject({ type: 'choice' });
  if (result.evidence.type !== 'choice') throw new Error('Expected evidence choice');
  expect(result.evidence.choice).not.toBe('none');
});
it('keeps the already accepted staged subgroup preference when generic acceptance uses letter options', async () => {
  const set = filingQuestionSet(context, source('rollback-runbook'), [...groups, { key: 'custom:release/staged', name: 'Staged', definition: 'Accepted staged rollout subgroup' }], false);
  const response = await acceptanceReflexProvider('https://api.typesafe.ai/v1/systemone', { method: 'POST', body: JSON.stringify({ model: 'jev-1.13.0', ...set }) });
  expect(await response.json()).toMatchObject({ answers: { place: { choice: 'D' }, gate: { choice: 'D' } } });
});
