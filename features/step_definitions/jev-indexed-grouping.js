import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { CanvasStore } from '../../server/storage.ts';
import { JevRuntime } from '../../server/jev/runtime.ts';
import { JevWorkspaceFiles } from '../../server/jev/workspace.ts';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from '../../server/jev/actions/question-state-pool.test.helpers.ts';

const owner = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
function scoped(body, key) {
  let state = body.state; let name = key; let match;
  while ((match = /^(\d+)__(.+)$/.exec(name))) {
    state = state.questionSets[Number(match[1])]; name = match[2];
  }
  return { state: resolveSharedQuestionSources(state, body.state.sourceStates), name };
}
function answer(world, body, key, submitted) {
  const question = resolveSharedQuestionTexts(submitted, body.state.questionTexts);
  const { state, name } = scoped(body, key);
  if (state.organizationSignals) world.groupingInputs.push(state);
  if (question.type === 'noul') {
    const semantic = /^(purpose|containment)_/.test(name);
    if (semantic) world.groupingSemanticChecks += 1;
    return { type: 'noul', noul: semantic ? world.groupingSupport : name === 'addressesAi' ? .01 : .99 };
  }
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const selected = name === 'group' ? keys.find(key => key.startsWith('g')) ?? 'none'
    : keys.includes('p1') ? 'p1' : keys.includes('reference') ? 'reference' : keys[0];
  const probabilities = Object.fromEntries(keys.map(key => [key, Number(key === selected)]));
  return question.type === 'choice' ? { type: 'choice', choice: selected, confidence: 1, probabilities }
    : { type: 'score', score: Number(selected), confidence: 1, probabilities };
}
Given('an isolated indexed grouping fixture with {string} semantic evidence', async function (kind) {
  this.groupingRoot = await mkdtemp(join(tmpdir(), 'jev-indexed-grouping-'));
  this.groupingStore = new CanvasStore(this.groupingRoot);
  await this.groupingStore.init(); await this.groupingStore.deleteWorkspace('acme-team');
  this.groupingWorkspace = (await this.groupingStore.createWorkspace({ name: 'Offline indexed grouping' })).id;
  this.groupingCanvas = (await this.groupingStore.createCanvas(this.groupingWorkspace, { name: 'Knowledge' })).id;
  this.groupingSupport = { supported: .99, 'incidental linked': .01, 'below threshold': .69 }[kind];
  assert.equal(typeof this.groupingSupport, 'number');
  const incidental = kind === 'incidental linked';
  this.groupingKey = incidental ? 'custom:payroll' : 'custom:release-evidence';
  this.groupingPeer = await this.groupingStore.createBlock(this.groupingCanvas, {
    title: incidental ? 'Payroll records' : 'Release evidence reference', group: this.groupingKey,
    tags: [incidental ? 'Payroll' : 'Release evidence'],
    content: incidental ? '# Payroll\nSalary calculations and annual deductions. A release party is mentioned in passing.'
      : '# Release evidence\nRelease acceptance requires the checked deployment record.' });
  this.groupingSource = await this.groupingStore.createBlock(this.groupingCanvas, { title: 'Deployment acceptance',
    content: '# Release evidence\nRelease acceptance requires the checked deployment record.',
    tags: ['Release evidence'], links: [this.groupingPeer.id], linkTypes: { [this.groupingPeer.id]: 'prerequisite' }, x: 123, y: 456 });
  this.groupingSource = await this.groupingStore.updateBlock(this.groupingCanvas, this.groupingSource.id,
    { links: [this.groupingPeer.id], linkTypes: { [this.groupingPeer.id]: 'prerequisite' } }, 'Browser');
  this.groupingFiles = new JevWorkspaceFiles(this.groupingRoot);
  const state = await this.groupingFiles.read(this.groupingWorkspace); state.settings.paused = true;
  state.vocabulary.push({ id: 'checked-group', kind: 'group', name: incidental ? 'Payroll' : 'Release evidence',
    groupKey: this.groupingKey, definition: incidental ? 'Salary calculations and employment deductions only.'
      : 'Release acceptance and checked deployment evidence.', aliases: [], state: 'active', version: 1,
    members: [{ canvasId: this.groupingCanvas, blockId: this.groupingPeer.id }] });
  await this.groupingFiles.write(this.groupingWorkspace, state);
  this.groupingInputs = []; this.groupingSemanticChecks = 0;
  this.groupingRuntime = new JevRuntime(this.groupingStore, { apiKey: 'offline-grouping-fixture', startTimer: false,
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json({ answers: Object.fromEntries(Object.entries(body.questions)
        .map(([key, question]) => [key, answer(this, body, key, question)])) });
    } });
  await this.groupingRuntime.idle();
  const ready = await this.groupingFiles.read(this.groupingWorkspace); ready.settings.paused = false;
  await this.groupingFiles.write(this.groupingWorkspace, ready);
});
After({ tags: '@indexed-grouping' }, async function () {
  await this.groupingRuntime?.shutdown();
  if (this.groupingRoot) await rm(this.groupingRoot, { recursive: true, force: true });
});
When('Jev profiles the source and then evaluates its filing through the public runtime', async function () {
  for (const action of ['profile', 'file']) {
    const job = await this.groupingRuntime.run(this.groupingWorkspace,
      { action, canvasId: this.groupingCanvas, blockIds: [this.groupingSource.id] }, owner);
    await this.groupingRuntime.idle();
    const state = await this.groupingRuntime.read(this.groupingWorkspace, owner);
    const completed = state.jobs.find(item => item.id === job.id);
    assert.equal(completed.state, 'completed', completed.error);
  }
  this.groupingResult = await new JevWorkspaceFiles(this.groupingRoot).read(this.groupingWorkspace);
});
Then('its logical topics and exact evidence survive native reload', function () {
  const index = this.groupingResult.profiles[`${this.groupingCanvas}:${this.groupingSource.id}`].logicalIndex;
  assert.equal(index.version, 1); assert.ok(index.topics.length > 0);
  const topic = index.topics.find(item => item.name === 'Release evidence');
  assert.ok(topic); assert.equal(topic.confidence, .99); assert.ok(topic.evidence.length > 0);
  for (const evidence of topic.evidence) {
    assert.equal(evidence.source.blockId, this.groupingSource.id);
    assert.equal(this.groupingSource.content.slice(evidence.start, evidence.end), evidence.quote);
  }
});
Then('the filing decision receives the current logical index labels and directional links', function () {
  assert.ok(this.groupingInputs.length > 0); assert.ok(this.groupingSemanticChecks > 0);
  for (const input of this.groupingInputs) {
    const signals = input.organizationSignals;
    assert.ok(signals.logicalIndex.topics.some(topic => topic.name === 'Release evidence'));
    assert.deepEqual(signals.labels, ['Release evidence']);
    const peer = signals.neighbors.find(neighbor => neighbor.blockId === this.groupingPeer.id);
    assert.ok(peer); assert.deepEqual(peer.relations, ['outgoing:prerequisite']);
    assert.equal(peer.group, this.groupingKey);
  }
  assert.equal(this.groupingResult.settings.confidenceThresholds.file, .7);
});
Then('the supported group is durably applied without changing content labels or positions', async function () {
  const source = await new CanvasStore(this.groupingRoot).getCanvasBlock(this.groupingCanvas, this.groupingSource.id);
  assert.equal(source.group, this.groupingKey);
  assert.ok(this.groupingResult.receipts.some(receipt => receipt.action === 'file' && receipt.state === 'applied'));
  for (const key of ['content', 'tags', 'links', 'linkTypes', 'x', 'y']) assert.deepEqual(source[key], this.groupingSource[key]);
});
Then('semantic rejection leaves the document ungrouped at the existing confidence threshold', async function () {
  const source = await new CanvasStore(this.groupingRoot).getCanvasBlock(this.groupingCanvas, this.groupingSource.id);
  assert.equal(source.group, undefined); assert.equal(this.groupingResult.settings.confidenceThresholds.file, .7);
  assert.equal(this.groupingResult.receipts.some(receipt => receipt.action === 'file'), false);
  for (const key of ['content', 'tags', 'links', 'linkTypes', 'x', 'y']) assert.deepEqual(source[key], this.groupingSource[key]);
});
