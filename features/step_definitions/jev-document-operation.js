import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { CanvasStore } from '../../server/storage.ts';
import { JevRuntime } from '../../server/jev/runtime.ts';
import { JevWorkspaceFiles } from '../../server/jev/workspace.ts';
import { automationPrincipal } from '../../server/jev/authorization.ts';
import { jevActions } from '../../shared/jev-types.ts';
import { resolveSharedQuestionTexts } from '../../server/jev/actions/question-state-pool.test.helpers.ts';

function abstain(question) {
  if (question.type === 'noul') return { type: 'noul', noul: 0.01 };
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const selected = keys.includes('none') ? 'none' : keys[0];
  const probabilities = Object.fromEntries(keys.map(key => [key, Number(key === selected)]));
  return question.type === 'choice' ? { type: 'choice', choice: selected, confidence: 1, probabilities }
    : { type: 'score', score: 0, confidence: 1, probabilities };
}

Given('an isolated document operation with an offline decision provider', async function () {
  this.documentRoot = await mkdtemp(join(tmpdir(), 'jev-document-acceptance-'));
  this.documentStore = new CanvasStore(this.documentRoot);
  await this.documentStore.init(); await this.documentStore.deleteWorkspace('acme-team');
  this.documentWorkspace = (await this.documentStore.createWorkspace({ name: 'Offline document operation' })).id;
  this.documentCanvas = (await this.documentStore.createCanvas(this.documentWorkspace, { name: 'Knowledge' })).id;
  this.documentSource = await this.documentStore.createBlock(this.documentCanvas,
    { title: 'Release', content: '# Release\nRetain the release checklist.', group: 'custom:manual', tags: ['Manual'], x: 123, y: 456 });
  this.documentFiles = new JevWorkspaceFiles(this.documentRoot);
  const state = await this.documentFiles.read(this.documentWorkspace); state.settings.paused = true;
  await this.documentFiles.write(this.documentWorkspace, state); this.documentCalls = 0;
  this.documentRuntime = new JevRuntime(this.documentStore, { apiKey: 'offline-fixture', startTimer: false,
    fetcher: async (_url, init) => {
      this.documentCalls += 1;
      const body = JSON.parse(init.body);
      const questions = resolveSharedQuestionTexts(body.questions, body.state.questionTexts);
      return Response.json({ answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, abstain(question)])) });
    } });
  await this.documentRuntime.idle();
  const ready = await this.documentFiles.read(this.documentWorkspace); ready.settings.paused = false;
  await this.documentFiles.write(this.documentWorkspace, ready); this.documentRevision = ready.revision;
});

After({ tags: '@document-operation' }, async function () {
  await this.documentRuntime?.shutdown();
  if (this.documentRoot) await rm(this.documentRoot, { recursive: true, force: true });
});

When('the automatic document operation completes', async function () {
  await this.documentRuntime.run(this.documentWorkspace,
    { action: 'profile', canvasId: this.documentCanvas, blockIds: [this.documentSource.id] }, automationPrincipal);
  await this.documentRuntime.idle();
});

Then('six current outcomes survive reload in three workspace writes', async function () {
  this.documentCompleted = await new JevWorkspaceFiles(this.documentRoot).read(this.documentWorkspace);
  assert.equal(this.documentCompleted.revision - this.documentRevision, 3, JSON.stringify(this.documentCompleted.jobs.map(job => ({ action: job.request.action, state: job.state, error: job.error, result: job.result }))));
  assert.equal(this.documentCompleted.jobs.length, 6);
  assert.deepEqual(new Set(this.documentCompleted.jobs.map(job => job.request.action)), new Set(jevActions));
  assert.ok(this.documentCompleted.jobs.every(job => job.state === 'completed'));
  assert.match(this.documentCompleted.profiles[`${this.documentCanvas}:${this.documentSource.id}`].organizationContextKey, /^[a-f0-9]{64}$/);
  assert.ok(this.documentCalls <= 2);
});

Then('the document content manual organization and position are preserved', async function () {
  const current = await new CanvasStore(this.documentRoot).getCanvasBlock(this.documentCanvas, this.documentSource.id);
  for (const key of ['content', 'group', 'tags', 'x', 'y', 'jevOwnership']) assert.deepEqual(current[key], this.documentSource[key]);
});

When('unchanged automatic documents are checked again', async function () {
  this.documentCallsBefore = this.documentCalls;
  await this.documentRuntime.tick(); await this.documentRuntime.idle();
});

Then('no new decisions or document operations are created', async function () {
  assert.equal(this.documentCalls, this.documentCallsBefore);
  const current = await new JevWorkspaceFiles(this.documentRoot).read(this.documentWorkspace);
  assert.deepEqual(current.jobs, this.documentCompleted.jobs);
});

When('the seven removed actions are requested', async function () {
  this.documentBeforeRemoved = await this.documentFiles.read(this.documentWorkspace);
  this.documentCallsBeforeRemoved = this.documentCalls;
  for (const action of ['vocab_lifecycle', 'score_quality', 'flag_conflict', 'recheck_links', 'attach_doc_to_task', 'assign_owner', 'recall']) {
    await assert.rejects(this.documentRuntime.run(this.documentWorkspace,
      { action, canvasId: this.documentCanvas, blockIds: [this.documentSource.id] }, automationPrincipal), { status: 400 });
  }
});

Then('each removed action is rejected without decisions jobs or durable writes', async function () {
  assert.equal(this.documentCalls, this.documentCallsBeforeRemoved);
  assert.deepEqual(await this.documentFiles.read(this.documentWorkspace), this.documentBeforeRemoved);
});
