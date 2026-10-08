import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { JevPrincipal } from '../../../shared/jev-types.js';
import { CanvasStore } from '../../storage.js';
import type { JevAnswer, JevQuestion } from '../../jev.js';
import { JevRuntime } from '../runtime.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './question-state-pool.test.helpers.js';

type Source = { title: string; passages: Array<{ id: string; text: string }> };
type State = { document?: Source; source?: Source; selectedGroup?: { name: string };
  groups?: Array<{ option: string; key: string; name: string }>; peerSubjects?: Source[];
  logicalTopicCandidates?: Array<{ name: string }>; labelCandidates?: Array<{ name: string }> };
const owner: JevPrincipal = { id: 'launch-owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
const opened: Array<{ runtime: JevRuntime; root: string }> = [];
const files = ['sso-security-review', 'pen-test', 'access-policy', 'pricing-decision', 'pricing-copy',
  'launch-blockers', 'rollback-runbook', 'rollback-runbook-copy'];

afterEach(async () => {
  for (const fixture of opened.splice(0)) {
    await fixture.runtime.shutdown();
    await rm(fixture.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function scoped(wireId: string, wire: Record<string, unknown>) {
  const pool = wire.sourceStates;
  let id = wireId;
  let state = wire;
  let prefix: RegExpExecArray | null;
  while ((prefix = /^(\d+)__(.+)$/.exec(id))) {
    state = (state.questionSets as Record<string, unknown>[])[Number(prefix[1])];
    id = prefix[2];
  }
  return { id, state: resolveSharedQuestionSources(state, pool) as State };
}
function mainCategory(source: Source | undefined): string | undefined {
  const category = source?.passages.find(item => /^## (Security|Pricing|Release)$/.test(item.text))?.text.replace(/^##\s+/, '');
  const purpose = source?.passages.find(item => !/^#/.test(item.text))?.text ?? '';
  const subjects: Record<string, RegExp> = { Security: /SSO|SAML|authenticate|audience validation/i,
    Pricing: /price|pricing|per seat|\$\d+/i, Release: /launch|rollout|rollback|deployment/i };
  return category && subjects[category].test(purpose) ? category : undefined;
}

function answer(wireId: string, submitted: JevQuestion, wire: Record<string, unknown>): JevAnswer {
  const question = resolveSharedQuestionTexts(submitted, wire.questionTexts);
  const { id, state } = scoped(wireId, wire);
  const match = /^(logicalTopic|logicalTopicEvidence|label|evidence)_(\d+)$/.exec(id);
  const candidates = id.startsWith('logicalTopic') ? state.logicalTopicCandidates : state.labelCandidates;
  const name = match ? candidates?.[Number(match[2])]?.name : undefined;
  const passage = state.document?.passages.find(item => name && item.text.replace(/^#{1,6}\s+/, '').trim() === name);
  const category = state.source?.passages.find(item => /^## (Security|Pricing|Release)$/.test(item.text));
  const topic = mainCategory(state.document ?? state.source);
  const groupFit = topic !== undefined && topic === state.selectedGroup?.name;
  const independent = id === 'independent' && topic !== undefined
    && (state.peerSubjects ?? []).every(peer => mainCategory(peer) !== undefined && mainCategory(peer) !== topic);
  if (question.type === 'noul') return { type: 'noul', noul: passage || groupFit || independent ? .98 : .01 };
  if (question.type === 'score') return { type: 'score', score: 0, confidence: .98,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), Number(index === 0)])) };
  const groupChoice = category && Object.keys(question.criteria).find(key => question.criteria[key].startsWith(category.text.replace(/^##\s+/, '') + ' ('));
  const choice = id === 'overlap' ? 'distinct' : id === 'relation' ? 'none'
    : id === 'place' || id === 'gate' ? state.groups?.find(group => group.name === topic)?.option ?? 'none'
    : id === 'group' ? groupChoice ?? 'none' : id === 'evidence' ? groupFit ? category!.id : 'none'
    : id === 'role' ? Object.keys(question.criteria)[0]
      : id === 'keyPassage' ? state.document?.passages[2]?.id ?? 'none' : passage?.id ?? 'none';
  return { type: 'choice', choice, confidence: .98,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === choice)])) };
}

async function fixture() {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.stubEnv('SYMBI_NO_PROVIDER_CALLS', '');
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-launch-labels-'));
  const store = new CanvasStore(root);
  await store.init();
  await store.deleteWorkspace('acme-team');
  const workspace = await store.createWorkspace({ name: 'Enterprise launch' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Shared launch memory' });
  const sources = await Promise.all(files.map(file => readFile(path.resolve('features/fixtures/shared-memory-launch', file + '.md'), 'utf8')));
  const blocks = [];
  for (const [index, content] of sources.entries()) {
    const heading = content.split('\n')[0].replace(/^#\s+/, '');
    blocks.push(await store.createBlock(canvas.id, { title: index === 7 ? heading + ' copy' : heading, content }));
  }
  const questionsSeen: Array<ReturnType<typeof scoped>> = [];
  const runtime = new JevRuntime(store, { startTimer: false, apiKey: 'native-launch-provider',
    decider: async (_key, state, questions) => Object.fromEntries(Object.entries(questions)
      .map(([id, question]) => {
        const frame = scoped(id, state as Record<string, unknown>);
        questionsSeen.push(frame);
        return [id, answer(id, question, state as Record<string, unknown>)];
      })) });
  opened.push({ root, runtime });
  await runtime.idle();
  return { root, store, runtime, workspace, canvas, blocks, sources, questionsSeen };
}

it('automatically organizes eight fresh launch sources and rechecks ordinary source edits while protecting manual metadata', async () => {
  const f = await fixture();
  expect(f.blocks.every(block => !block.tags?.length && !block.group)).toBe(true);
  expect(f.sources[6]).toBe(f.sources[7]);
  const saved = await new CanvasStore(f.root).getCanvas(f.canvas.id, true);
  expect(f.questionsSeen.filter(question => question.id === 'place' && question.state.document?.title === 'SSO security review')
    .flatMap(question => question.state.groups ?? []).map(group => ({ key: group.key, name: group.name })))
    .toEqual(expect.arrayContaining([expect.objectContaining({ key: 'custom:security' })]));
  const topics = ['Security', 'Security', 'Security', 'Pricing', 'Pricing', 'Release', 'Release', 'Release'];
  for (const [index, block] of saved.blocks.entries()) {
    const sourceTitle = f.sources[index].split('\n')[0].replace(/^#\s+/, '');
    expect(block.tags, block.title).toEqual([topics[index], sourceTitle]);
    expect(block.group, block.title).toBe(`custom:${topics[index].toLowerCase()}`);
    expect(block.content).toBe(f.sources[index]);
    expect(block.jevOwnership?.managed).toContain('tags');
  }
  const before = await f.runtime.read(f.workspace.id, owner);
  expect(before.receipts.filter(receipt => receipt.action === 'label' && receipt.automatic && receipt.state === 'applied')).toHaveLength(8);
  expect(before.receipts.filter(receipt => receipt.action === 'file' && receipt.automatic && receipt.after.kind === 'document')).toHaveLength(8);
  expect(before.jobs.filter(job => job.state === 'failed')).toEqual([]);
  expect(f.questionsSeen.some(question => question.id === 'place' && question.state.document?.title === 'SSO security review'
    && question.state.groups?.some(group => group.key === 'custom:security'))).toBe(true);
  const source = saved.blocks[0];
  await f.store.updateBlock(f.canvas.id, source.id, { tags: ['Owner verified'], group: 'custom:reviewed' }, 'Launch owner');
  await f.runtime.idle();
  const changed = await f.store.updateBlock(f.canvas.id, source.id, { content: '# SSO remediation\n\n## Security\n\nThe audience validation fix passed retesting. Administrator SSO enforcement remains mandatory.\n' }, 'Launch owner');
  await f.runtime.idle();
  const after = await f.runtime.read(f.workspace.id, owner);
  const reread = await new CanvasStore(f.root).getCanvasBlock(f.canvas.id, source.id);
  expect(reread).toMatchObject({ tags: ['Owner verified'], group: 'custom:reviewed', content: changed.content });
  expect(reread.jevOwnership?.pins).toEqual(expect.arrayContaining(['tags', 'group']));
  expect(after.profiles[`${f.canvas.id}:${source.id}`].logicalIndex).toMatchObject({ topics: expect.arrayContaining([
    expect.objectContaining({ name: 'SSO remediation' }),
  ]) });
  expect(after.profiles[`${f.canvas.id}:${source.id}`].source).toMatchObject({
    sourceGeneration: changed.sourceGeneration, contentHash: changed.contentHash,
  });
  expect(after.jobs.filter(job => job.state === 'failed')).toEqual([]);
  expect(after.receipts.some(receipt => receipt.action === 'profile' && receipt.automatic && receipt.sourcesAfter.some(snapshot =>
    snapshot.blockId === source.id && snapshot.contentHash === changed.contentHash && snapshot.sourceGeneration === changed.sourceGeneration))).toBe(true);
  expect(after.receipts.length).toBeGreaterThan(before.receipts.length);
}, 15_000);
