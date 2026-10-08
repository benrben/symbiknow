import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { CanvasStore } from '../../server/storage.ts';
import { JevRuntime } from '../../server/jev/runtime.ts';
import { JevWorkspaceFiles } from '../../server/jev/workspace.ts';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from '../../server/jev/actions/question-state-pool.test.helpers.ts';
import { calibrated, decisionBoundaries } from '../../server/jev/actions/calibration.ts';

const owner = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
function scoped(body, key) {
  let state = body.state; let name = key; let match;
  while ((match = /^(\d+)__(.+)$/.exec(name))) {
    state = state.questionSets[Number(match[1])]; name = match[2];
  }
  return { state: resolveSharedQuestionTexts(resolveSharedQuestionSources(state, body.state.sourceStates), body.state.questionTexts), name };
}
function answer(world, body, key, submitted) {
  const question = resolveSharedQuestionTexts(submitted, body.state.questionTexts);
  const { state, name } = scoped(body, key);
  if (name === 'place' && state.groups) world.groupingInputs.push(state);
  if (question.type === 'noul') {
    const semantic = /^(purpose|containment)_/.test(name);
    if (semantic) world.groupingSemanticChecks += 1;
    return { type: 'noul', noul: semantic ? world.groupingSupport : name === 'addressesAi' ? .01 : .99 };
  }
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  if (name === 'place' || name === 'gate') {
    world.groupingSemanticChecks += 1;
    const option = state.groups[0].option;
    const probability = name === 'gate' ? world.groupingSupport : 1;
    const choice = probability >= .5 ? option : 'none';
    return { type: 'choice', choice, confidence: 1,
      probabilities: Object.fromEntries(keys.map(key => [key, key === option ? probability : key === 'none' ? 1 - probability : 0])) };
  }
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
  this.groupingSupport = { supported: .99, 'incidental linked': .01, 'below threshold': .39 }[kind];
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
  assert.ok(topic); assert.equal(topic.confidence, calibrated(.99, decisionBoundaries.topicMembership)); assert.ok(topic.evidence.length > 0);
  for (const evidence of topic.evidence) {
    assert.equal(evidence.source.blockId, this.groupingSource.id);
    assert.equal(this.groupingSource.content.slice(evidence.start, evidence.end), evidence.quote);
  }
});
Then('the filing decision receives the source outline and checked group definitions without treating links as evidence', function () {
  assert.ok(this.groupingInputs.length > 0); assert.ok(this.groupingSemanticChecks > 0);
  for (const input of this.groupingInputs) {
    assert.equal(input.document.title, this.groupingSource.title);
    assert.deepEqual(input.document.sections, []);
    assert.ok(input.document.passages.some(passage => passage.text === 'Release acceptance requires the checked deployment record.'));
    assert.equal(input.organizationSignals, undefined);
  }
  const checkedGroups = this.groupingInputs.flatMap(input => input.groups.filter(group => group.key === this.groupingKey));
  assert.ok(checkedGroups.length > 0);
  for (const group of checkedGroups) {
    assert.ok(group.definition.includes(this.groupingKey === 'custom:payroll' ? 'Salary calculations' : 'checked deployment evidence'));
    assert.ok(group.members.some(member => member.title === this.groupingPeer.title));
  }
  assert.deepEqual(this.groupingSource.tags, ['Release evidence']);
  assert.deepEqual(this.groupingSource.links, [this.groupingPeer.id]);
  assert.equal(this.groupingSource.linkTypes[this.groupingPeer.id], 'prerequisite');
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

function refinementAnswer(world, body, key, submitted) {
  const question = resolveSharedQuestionTexts(submitted, body.state.questionTexts);
  const { state, name } = scoped(body, key);
  if (name === 'place') world.refinementInputs.push(state);
  if (/^purpose_/.test(name) && state.selectedGroup?.key === 'custom:authentication') world.refinementPurposeInputs.push(state);
  if (name === 'independent') world.refinementIndependentInputs.push(state);
  if (name === 'coherent' && state.selectedGroup?.key === 'custom:item_287_checklist') world.refinementRejectedFolders++;
  if (question.type === 'noul') {
    const reusable = name === 'coherent' && state.selectedGroup?.key === 'custom:item_287_checklist';
    const topicIndex = /^logicalTopic_(\d+)$/.exec(name)?.[1];
    const topic = topicIndex === undefined ? undefined : state.logicalTopicCandidates[Number(topicIndex)].name;
    const heading = state.document?.passages?.find(passage => passage.id === 'p0')?.text.replace(/^#+\s*/, '');
    const authenticationSource = /Authentication|Credential|Pinned/.test(state.document?.title ?? '');
    const supportedTopics = authenticationSource ? ['Security', heading] : [heading];
    const rejectedTopic = topic !== undefined && !supportedTopics.includes(topic);
    const sameSubject = name === 'independent' && /Authentication|Credential|Pinned/.test(state.source.title)
      && state.peerSubjects.some(peer => /Authentication|Credential|Pinned/.test(peer.title));
    const unrelatedPeer = /^purpose_/.test(name) && state.selectedGroup?.key === 'custom:authentication'
      && !/Authentication|Credential|Pinned/.test(state.source.title);
    return { type: 'noul', noul: reusable || rejectedTopic || sameSubject || unrelatedPeer || name === 'addressesAi' ? .01 : .99 };
  }
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  let selected;
  if (['place', 'gate'].includes(name)) {
    const title = state.document.title;
    const refined = state.groups.some(group => group.nomination);
    const wanted = title === 'Pinned manual source' ? 'custom:owner_reviewed'
      : !refined ? 'custom:engineering' : title === 'Search guide' ? 'custom:retrieval_knowledge'
        : title === 'Numbered record' ? 'custom:item_287_checklist' : 'custom:authentication';
    selected = state.groups.find(group => group.key === wanted)?.option ?? 'none';
  } else if (name === 'overlap') selected = 'distinct';
  else if (name === 'relation') selected = 'none';
  else if (name.startsWith('logicalTopicEvidence_')) {
    const index = Number(name.split('_')[1]);
    selected = ['Engineering', 'Security'].includes(state.logicalTopicCandidates[index].name) ? 'p1' : 'p0';
  }
  else selected = keys.includes('p1') ? 'p1' : keys.includes('reference') ? 'reference' : keys[0];
  return question.type === 'choice' ? { type: 'choice', choice: selected, confidence: 1,
    probabilities: Object.fromEntries(keys.map(key => [key, Number(key === selected)])) }
    : { type: 'score', score: Number(selected), confidence: 1,
      probabilities: Object.fromEntries(keys.map(key => [key, Number(key === selected)])) };
}
Given('an isolated broad group with different checked subject names and a meaningful singleton', async function () {
  this.groupingRoot = await mkdtemp(join(tmpdir(), 'jev-refinement-acceptance-'));
  this.groupingStore = new CanvasStore(this.groupingRoot);
  await this.groupingStore.init(); await this.groupingStore.deleteWorkspace('acme-team');
  this.groupingWorkspace = (await this.groupingStore.createWorkspace({ name: 'Source taxonomy' })).id;
  this.groupingCanvas = (await this.groupingStore.createCanvas(this.groupingWorkspace, { name: 'Technical knowledge' })).id;
  const inputs = [
    ['Authentication protocol', '# Session authentication\n\nAuthentication verifies credentials before issuing protected sessions.'],
    ['Credential protocol', '# Credential verification\n\nAuthentication validates account credentials before a protected session is issued.'],
    ['Search guide', '# Retrieval knowledge\n\nVector retrieval ranks relevant document passages for evidence-backed search.'],
    ['Numbered record', '# Item 287 checklist\n\nThis numbered checklist records one assigned item and its completion.'],
    ['Pinned manual source', '# Session authorization\n\nAuthentication checks account permissions before issuing a session.'],
  ];
  this.refinementSources = [];
  for (const [title, content] of inputs) this.refinementSources.push(await this.groupingStore.createBlock(this.groupingCanvas,
    { title, content, group: title === 'Pinned manual source' ? 'custom:owner_reviewed' : 'custom:engineering', tags: ['Owner kept'], x: 123, y: 456 }));
  this.groupingFiles = new JevWorkspaceFiles(this.groupingRoot);
  const state = await this.groupingFiles.read(this.groupingWorkspace); state.settings.paused = true;
  state.vocabulary.push({ id: 'broad-technical-group', kind: 'group', name: 'Engineering', groupKey: 'custom:engineering',
    definition: 'Building and maintaining technical systems.', aliases: [], state: 'active', version: 1,
    members: this.refinementSources.slice(0, 4).map(source => ({ canvasId: this.groupingCanvas, blockId: source.id })) });
  await this.groupingFiles.write(this.groupingWorkspace, state);
  this.refinementInputs = [];
  this.refinementPurposeInputs = []; this.refinementIndependentInputs = []; this.refinementRejectedFolders = 0;
  this.groupingRuntime = new JevRuntime(this.groupingStore, { apiKey: 'offline-refinement-fixture', startTimer: false,
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json({ answers: Object.fromEntries(Object.entries(body.questions)
        .map(([key, question]) => [key, refinementAnswer(this, body, key, question)])) });
    } });
  await this.groupingRuntime.idle();
  const ready = await this.groupingFiles.read(this.groupingWorkspace); ready.settings.paused = false;
  await this.groupingFiles.write(this.groupingWorkspace, ready);
  for (const source of this.refinementSources.slice(0, 4)) await this.groupingRuntime.setMetadata(this.groupingWorkspace,
    this.groupingCanvas, source.id, { pins: ['tags'], managed: ['group'] }, owner);
  this.refinementBefore = await Promise.all(this.refinementSources.map(source => this.groupingStore.getCanvasBlock(this.groupingCanvas, source.id)));
});
When('the public Reflex runtime profiles and refines the managed broad group', async function () {
  for (const action of ['profile', 'file']) {
    const job = await this.groupingRuntime.run(this.groupingWorkspace, { action, canvasId: this.groupingCanvas,
      blockIds: this.refinementSources.map(source => source.id) }, owner);
    await this.groupingRuntime.idle();
    const state = await this.groupingRuntime.read(this.groupingWorkspace, owner);
    const result = state.jobs.find(item => item.id === job.id);
    assert.equal(result.state, 'completed', result.error);
  }
  this.refinementSaved = await new JevWorkspaceFiles(this.groupingRoot).read(this.groupingWorkspace);
});
Then('the shared family and singleton refinements survive native store reload with exact member evidence', async function () {
  const reopened = new CanvasStore(this.groupingRoot);
  const expected = ['custom:authentication', 'custom:authentication', 'custom:retrieval_knowledge'];
  for (const [index, group] of expected.entries()) {
    const original = this.refinementBefore[index];
    const current = await reopened.getCanvasBlock(this.groupingCanvas, original.id);
    assert.equal(current.group, group);
    for (const field of ['content', 'tags', 'x', 'y']) assert.deepEqual(current[field], original[field]);
    const proposal = this.refinementSaved.proposals.find(proposal => proposal.action === 'file' && proposal.state === 'applied'
      && proposal.mutation.kind === 'document' && proposal.mutation.blockId === original.id);
    assert.ok(proposal); assert.ok(proposal.evidence.length > 0);
    for (const evidence of proposal.evidence) {
      assert.equal(evidence.source.blockId, original.id);
      assert.equal(original.content.slice(evidence.start, evidence.end), evidence.quote);
      assert.ok(!evidence.quote.startsWith('#'));
    }
    assert.ok(this.refinementSaved.receipts.some(receipt => receipt.action === 'file' && receipt.state === 'applied'
      && receipt.proposalId === proposal.id));
  }
  assert.ok(this.refinementInputs.some(input => input.groups.some(group => group.key === 'custom:engineering')
    && input.groups.some(group => group.key === 'custom:credential_verification' && group.nomination === 'source_subject')));
  const singleton = this.refinementSaved.vocabulary.find(term => term.groupKey === 'custom:retrieval_knowledge');
  assert.ok(singleton); assert.deepEqual(singleton.members, [{ canvasId: this.groupingCanvas, blockId: this.refinementBefore[2].id }]);
  const family = this.refinementSaved.vocabulary.find(term => term.groupKey === 'custom:authentication');
  assert.ok(family);
  assert.ok(family.members.some(member => member.blockId === this.refinementBefore[0].id));
  assert.ok(family.members.some(member => member.blockId === this.refinementBefore[1].id));
  for (const source of this.refinementBefore.slice(0, 2)) {
    assert.ok(this.refinementPurposeInputs.some(input => input.source.id === source.id
      && input.source.passages.some(passage => passage.text.includes('Authentication'))));
  }
  const definition = this.refinementSaved.proposals.find(proposal => proposal.state === 'applied'
    && proposal.mutation.kind === 'vocabulary' && proposal.mutation.term.groupKey === family.groupKey);
  assert.ok(definition);
  const examples = this.refinementBefore.filter(source => /Authentication|Credential|Pinned/.test(source.title)
    && family.definition.includes(source.content.split('\n\n')[1]));
  assert.ok(examples.length >= 2);
  assert.ok(examples.some(source => this.refinementBefore.slice(0, 2).some(member => member.id === source.id)));
  for (const source of examples) {
    const body = source.content.split('\n\n')[1];
    assert.ok(definition.evidence.some(evidence => evidence.source.blockId === source.id
      && evidence.quote === body && source.content.slice(evidence.start, evidence.end) === body));
    assert.ok(definition.sources.some(guard => guard.blockId === source.id
      && guard.incarnation === source.incarnation && guard.contentHash === source.contentHash));
    assert.ok(this.refinementPurposeInputs.some(input => input.source.id === source.id
      && input.source.passages.some(passage => passage.text.includes(body))));
  }
  const definitionReceipt = this.refinementSaved.receipts.findIndex(receipt => receipt.proposalId === definition.id && receipt.state === 'applied');
  assert.ok(definitionReceipt >= 0);
  for (const source of this.refinementBefore.slice(0, 2)) {
    const placement = this.refinementSaved.proposals.find(proposal => proposal.action === 'file' && proposal.state === 'applied'
      && proposal.mutation.kind === 'document' && proposal.mutation.blockId === source.id);
    const placementReceipt = this.refinementSaved.receipts.findIndex(receipt => receipt.proposalId === placement.id && receipt.state === 'applied');
    assert.ok(placementReceipt > definitionReceipt);
  }
  assert.ok(this.refinementIndependentInputs.some(input => input.source.title === 'Search guide'
    && input.peerSubjects.some(peer => peer.title === 'Authentication protocol')));
});
Then('numbered document folders and owner-pinned groups remain unchanged', async function () {
  for (const original of this.refinementBefore.slice(3)) {
    const current = await new CanvasStore(this.groupingRoot).getCanvasBlock(this.groupingCanvas, original.id);
    for (const field of ['content', 'group', 'tags', 'x', 'y']) assert.deepEqual(current[field], original[field]);
  }
  assert.ok(this.refinementBefore[4].jevOwnership.pins.includes('group'));
  assert.equal(this.refinementSaved.vocabulary.some(term => term.groupKey === 'custom:item_287_checklist'), false);
  assert.ok(this.refinementRejectedFolders > 0);
});
