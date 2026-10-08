import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { JevPrincipal } from '../../../shared/jev-types.js';
import { CanvasStore } from '../../storage.js';
import { projectCanvasJevStatus } from '../../jev-canvas-status.js';
import { JevRuntime } from '../runtime.js';
import { launchDryRunAnswer, launchQuestionState, type LaunchDryRunState } from '../../../features/launch-dry-run-provider.js';

const owner: JevPrincipal = { id: 'dry-run-owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
const opened: Array<{ root: string; runtime: JevRuntime }> = [];
const files = ['sso-security-review', 'pen-test-findings', 'access-control-policy', 'pricing-tiers-decision',
  'pricing-page-copy', 'launch-blockers', 'rollback-runbook', 'rollback-steps-copy'];
const expectedTopics = ['Security', 'Security', 'Security', 'Pricing', 'Pricing', 'Release', 'Release', 'Release'];
type RecordedQuestion = { id: string; state: LaunchDryRunState };
let baseline: Awaited<ReturnType<typeof buildBaseline>>;
let baselineRoot: string;
let baselineRuntime: JevRuntime | undefined;

beforeAll(async () => {
  baseline = await buildBaseline();
  // Finish every real native write before any case copies this immutable directory.
  await baseline.runtime.shutdown();
});

afterAll(async () => {
  await baselineRuntime?.shutdown();
  if (baselineRoot) await rm(baselineRoot, { recursive: true, force: true });
});

afterEach(async () => {
  for (const fixture of opened.splice(0)) { await fixture.runtime.shutdown(); await rm(fixture.root, { recursive: true, force: true }); }
  vi.unstubAllEnvs();
});

function createRuntime(store: CanvasStore, questionsSeen: RecordedQuestion[]) {
  return new JevRuntime(store, { startTimer: false, apiKey: 'synthetic-dry-run-key', decider: async (_key, state, questions) => {
    const wire = state as Record<string, unknown>;
    for (const id of Object.keys(questions)) questionsSeen.push(launchQuestionState(id, wire));
    return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, launchDryRunAnswer(id, question, wire)]));
  } });
}

async function buildBaseline() {
  vi.stubEnv('TYPESAFE_API_KEY', ''); vi.stubEnv('SYMBI_NO_PROVIDER_CALLS', '');
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-exact-launch-')); const store = new CanvasStore(root);
  baselineRoot = root;
  await store.init(); await store.deleteWorkspace('acme-team');
  const workspace = await store.createWorkspace({ name: 'Exact enterprise launch documents' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Launch memory' });
  const sources = await Promise.all(files.map(file => readFile(path.resolve('features/fixtures/launch-dry-run', file + '.md'), 'utf8')));
  const blocks = [];
  for (const content of sources) blocks.push(await store.createBlock(canvas.id, { title: content.split('\n')[0].replace(/^#\s+/, ''), content }));
  const questionsSeen: RecordedQuestion[] = [];
  const runtime = createRuntime(store, questionsSeen);
  baselineRuntime = runtime; await runtime.idle();
  return { root, store, runtime, workspace, canvas, blocks, sources, questionsSeen };
}

async function fixture() {
  vi.stubEnv('TYPESAFE_API_KEY', ''); vi.stubEnv('SYMBI_NO_PROVIDER_CALLS', '');
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-exact-launch-case-'));
  await cp(baseline.root, root, { recursive: true });
  const store = new CanvasStore(root); await store.init();
  const questionsSeen = structuredClone(baseline.questionsSeen);
  const runtime = createRuntime(store, questionsSeen);
  opened.push({ root, runtime }); await runtime.idle();
  return { ...baseline, root, store, runtime, questionsSeen };
}

it('automatically files the exact eight no-H2 sources by shared main topics, saves canonical category definitions, and detects the heading-only copy', async () => {
  const f = await fixture(); expect(f.sources.every(content => !/^##\s/m.test(content))).toBe(true);
  expect(f.blocks.every(block => !block.tags?.length && !block.group)).toBe(true);
  const saved = await new CanvasStore(f.root).getCanvas(f.canvas.id, true);
  for (const [index, block] of saved.blocks.entries()) {
    expect(block.content, block.title).toBe(f.sources[index]); expect(block.tags, block.title).toEqual([expectedTopics[index]]);
    expect(block.group, block.title).toBe(`custom:${expectedTopics[index].toLowerCase()}`); expect(block.jevMutationId).toBeTruthy();
  }
  const state = await f.runtime.read(f.workspace.id, owner);
  expect(state.jobs.filter(job => job.state === 'failed')).toEqual([]);
  const groups = state.vocabulary.filter(term => term.kind === 'group');
  expect(groups.map(group => group.name).sort()).toEqual(['Pricing', 'Release', 'Security']);
  const scopePhrases: Record<string, string> = { Security: 'authentication', Pricing: 'plan entitlements', Release: 'staged rollouts' };
  for (const group of groups) {
    const index = expectedTopics.indexOf(group.name);
    expect(state.profiles[`${f.canvas.id}:${f.blocks[index].id}`].logicalIndex).toMatchObject({
      topics: expect.arrayContaining([expect.objectContaining({ name: group.name,
        definition: expect.stringContaining(scopePhrases[group.name]) })]),
    });
    expect(group.definition.length).toBeGreaterThan(100); expect(group.definition).not.toMatch(/^#/);
    expect(group.definition).toContain(scopePhrases[group.name]);
  }
  const duplicate = state.proposals.find(proposal => proposal.action === 'flag_duplicate' && proposal.mutation.kind === 'derived'
    && [f.blocks[6].id, f.blocks[7].id].includes(proposal.mutation.blockId ?? '')
    && [f.blocks[6].id, f.blocks[7].id].includes(String(proposal.mutation.values.targetId)));
  expect(duplicate?.mutation).toMatchObject({ kind: 'derived', values: { method: 'substantive_content', confidence: 1 } });
  expect(f.sources[6]).not.toBe(f.sources[7]);
  const projected = await projectCanvasJevStatus(new CanvasStore(f.root), saved);
  expect(projected.blocks[6].jevDuplicates?.some(related => related.blockId === f.blocks[7].id)).toBe(true);
  expect(projected.blocks[7].jevDuplicates?.some(related => related.blockId === f.blocks[6].id)).toBe(true);
  const copy = saved.blocks[4]; expect(copy.tags).not.toContain('Security'); expect(copy.tags).not.toContain('Release');
  expect(f.questionsSeen.some(question => question.id.startsWith('logicalTopic_') && question.state.logicalTopicCandidates?.some(candidate => candidate.name === 'Pricing' && candidate.definition))).toBe(true);
  expect(f.questionsSeen.some(question => question.id === 'place' && question.state.document?.title === 'Pricing tiers decision'
    && question.state.groups?.some(group => group.key === 'custom:pricing'))).toBe(true);
  expect(f.questionsSeen.some(question => question.id === 'independent' && question.state.source?.title === 'Pricing tiers decision'
    && Array.isArray(question.state.peerSubjects) && question.state.peerSubjects.length > 0)).toBe(true);
});

it('saves directional named prerequisites from exact body references while rejecting the reverse direction', async () => {
  const f = await fixture(); const saved = await new CanvasStore(f.root).getCanvas(f.canvas.id, true);
  const [sso, pen, , pricing, copy, launch, rollback] = saved.blocks;
  expect(copy.linkTypes?.[pricing.id]).toBe('prerequisite'); expect(pricing.linkTypes?.[sso.id], JSON.stringify(f.questionsSeen.filter(question => question.state.source?.id === pricing.id && question.state.target?.id === sso.id))).toBe('prerequisite');
  expect(launch.linkTypes?.[sso.id]).toBe('prerequisite'); expect(launch.linkTypes?.[pen.id]).toBe('prerequisite');
  expect(launch.linkTypes?.[copy.id]).toBe('prerequisite'); expect(launch.linkTypes?.[rollback.id]).toBe('related');
  expect(sso.linkTypes?.[launch.id]).toBeUndefined();
});

it('rechecks changed main-subject body evidence after a canonical source edit and reload', async () => {
  const f = await fixture(); const saved = await new CanvasStore(f.root).getCanvas(f.canvas.id, true);
  const copy = saved.blocks[4];
  const before = await f.runtime.read(f.workspace.id, owner);
  const edited = await f.store.updateBlock(f.canvas.id, copy.id, { content: '# Pricing page copy (draft)\n\nAuthentication permissions enforce account access.\nThe SAML login flow has been reviewed.' }, 'Dry-run editor');
  await f.runtime.idle(); const after = await f.runtime.read(f.workspace.id, owner);
  const reloaded = await new CanvasStore(f.root).getCanvasBlock(f.canvas.id, copy.id);
  expect(reloaded.content).toBe(edited.content); expect(reloaded.tags).toEqual(['Security']); expect(reloaded.group).toBe('custom:security');
  expect(after.profiles[`${f.canvas.id}:${copy.id}`].source).toMatchObject({ contentHash: edited.contentHash, sourceGeneration: edited.sourceGeneration });
  expect(after.receipts.length).toBeGreaterThan(before.receipts.length); expect(after.jobs.filter(job => job.state === 'failed')).toEqual([]);
});
