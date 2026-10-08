import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { CanvasStore } from '../../server/storage.ts';
import { atomicJson } from '../../server/storage-files.ts';
import { JevRuntime } from '../../server/jev/runtime.ts';
import { JevWorkspaceFiles } from '../../server/jev/workspace.ts';
import { automationPrincipal } from '../../server/jev/authorization.ts';

function choiceAnswer(probabilities) {
  const choice = Object.keys(probabilities).sort((left, right) => probabilities[right] - probabilities[left])[0];
  return { type: 'choice', choice, probabilities, confidence: .99 };
}

Given('an isolated home placement with {string} and an accepted destination gate', async function (mode) {
  assert.ok(['leading none', 'tied none'].includes(mode));
  this.homeRoot = await mkdtemp(join(tmpdir(), 'jev-home-retention-'));
  await atomicJson(join(this.homeRoot, 'workspaces.json'), []);
  this.homeStore = new CanvasStore(this.homeRoot); await this.homeStore.init();
  this.homeWorkspace = (await this.homeStore.createWorkspace({ name: 'Home retention' })).id;
  this.homeCurrent = (await this.homeStore.createCanvas(this.homeWorkspace, { name: 'Current notes' })).id;
  this.homeOther = (await this.homeStore.createCanvas(this.homeWorkspace, { name: 'Robotics' })).id;
  this.homeSource = await this.homeStore.createBlock(this.homeCurrent, {
    title: 'Robot feedback', content: '# Robot feedback\nControllers adjust motors using sensor feedback.', x: 123, y: 456,
  }, 'Browser');
  this.homeSource = await this.homeStore.getCanvasBlock(this.homeCurrent, this.homeSource.id);
  await this.homeStore.createBlock(this.homeOther, { title: 'Robot sensors', content: '# Robot sensors\nCamera and motor feedback.' }, 'Browser');
  const files = new JevWorkspaceFiles(this.homeRoot);
  const state = await files.read(this.homeWorkspace); state.settings.paused = true;
  await files.write(this.homeWorkspace, state); this.homeCalls = [];
  const place = mode === 'leading none' ? { A: .15, B: .38, none: .47 } : { A: .1, B: .45, none: .45 };
  this.homeRuntime = new JevRuntime(this.homeStore, {
    startTimer: false, documentExecution: false, apiKey: 'offline-home-retention',
    decider: async (_key, submittedState, questions) => {
      this.homeCalls.push({ state: submittedState, questions });
      assert.deepEqual(Object.keys(questions), ['place', 'gate']);
      return { place: choiceAnswer(place), gate: choiceAnswer({ A: .1, B: .21, none: .69 }) };
    },
  });
  await this.homeRuntime.idle();
  const ready = await files.read(this.homeWorkspace); ready.settings.paused = false;
  await files.write(this.homeWorkspace, ready);
});

When('the public Jev runtime evaluates the document home', async function () {
  this.homeJob = await this.homeRuntime.run(this.homeWorkspace,
    { action: 'suggest_home_canvas', canvasId: this.homeCurrent, blockIds: [this.homeSource.id] }, automationPrincipal);
  await this.homeRuntime.idle();
});

Then('one placement call and no evidence call produce a durable no change outcome', async function () {
  assert.equal(this.homeCalls.length, 1);
  assert.deepEqual(Object.keys(this.homeCalls[0].questions), ['place', 'gate']);
  const saved = await new JevWorkspaceFiles(this.homeRoot).read(this.homeWorkspace);
  const job = saved.jobs.find(job => job.id === this.homeJob.id);
  assert.equal(job.state, 'completed'); assert.deepEqual(job.proposalIds, []);
  assert.equal(job.result.documents[this.homeSource.id].status, 'no_change');
  assert.equal(job.result.documents[this.homeSource.id].calibration, 1);
  assert.equal(saved.proposals.some(proposal => proposal.action === 'suggest_home_canvas'), false);
});

Then('native reload preserves the document in its original canvas', async function () {
  const reloaded = new CanvasStore(this.homeRoot); await reloaded.init();
  assert.deepEqual(await reloaded.getCanvasBlock(this.homeCurrent, this.homeSource.id), this.homeSource);
  assert.equal((await reloaded.getCanvas(this.homeOther)).blocks.some(block => block.id === this.homeSource.id), false);
});

After({ tags: '@home-retention' }, async function () {
  await this.homeRuntime?.shutdown();
  if (this.homeRoot) await rm(this.homeRoot, { recursive: true, force: true });
});
