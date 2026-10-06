import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Given, When, Then } from '@cucumber/cucumber';
import { resolveSharedQuestionSources } from '../../server/jev/actions/question-state-pool.test.helpers.ts';

const retainedActions = ['profile', 'file', 'label', 'suggest_home_canvas', 'link', 'flag_duplicate'];
const actionLabels = ['Understand documents', 'Organize into groups', 'Suggest labels', 'Find a home canvas',
  'Find useful connections', 'Compare possible duplicates'];
const retiredActionLabels = ['Find conflicting claims', 'Recheck connections', 'Manage groups and labels',
  'Review document quality', 'Connect documents to work', 'Suggest responsibility', 'Find supporting knowledge'];
const removedActions = ['set_headline', 'set_freshness', 'flag_sensitive', 'order_reading', 'suggest_archive', 'mark_supersedes',
  'flag_gap', 'create_task_from_line', 'suggest_task_done', 'prioritize', 'where_to_put', 'route_chat', 'digest', 'review_agent_edit',
  'vocab_lifecycle', 'score_quality', 'flag_conflict', 'recheck_links', 'attach_doc_to_task', 'assign_owner', 'recall'];
const sourceContent = '# Release\nOwner: Ben\nBen owns the staged rollout.\nUse a staged rollout with a rollback checkpoint.';

async function response(world, route, method = 'GET', body) {
  return fetch(world.baseUrl + '/api' + route, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

async function request(world, route, method = 'GET', body) {
  const result = await response(world, route, method, body);
  assert.ok(result.ok, await result.clone().text());
  return result.json();
}

function stateRoute(world) { return `/workspaces/${world.reflexWorkspaceId}/jev/state`; }
function sourceRoute(world) { return `/canvases/${world.canvasId}/blocks/${world.reflexSource.id}`; }
function panel(world) { return world.page.getByRole('region', { name: 'Symbi Reflex organization', exact: true }); }

async function checked(world, predicate) {
  let state;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    state = await request(world, stateRoute(world));
    if (await predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Automatic Reflex did not settle: ${JSON.stringify(state)}\nServer: ${world.serverOutput}`);
}

async function isolatedWorkspace(world, key) {
  const workspace = await request(world, '/workspaces', 'POST', { name: 'Automatic Reflex acceptance' });
  const canvas = await request(world, `/workspaces/${workspace.id}/canvases`, 'POST', { name: 'Release knowledge' });
  // A second eligible destination exercises the home-canvas question while
  // the provider selects the existing first canvas for these sources.
  await request(world, `/workspaces/${workspace.id}/canvases`, 'POST', { name: 'Other knowledge' });
  world.reflexWorkspaceId = workspace.id; world.canvasId = canvas.id;
  if (key) await request(world, '/settings', 'PUT', { secrets: { TYPESAFE_API_KEY: key } });
}

Given('an isolated automatic Reflex workspace with a saved provider key', async function () {
  await isolatedWorkspace(this, 'acceptance-reflex-key');
});
Given('an isolated automatic Reflex workspace without a provider key', async function () { await isolatedWorkspace(this, ''); });

async function saveRolloutSources(world, referenceContent = sourceContent) {
  world.reflexTask = await request(world, `/canvases/${world.canvasId}/tasks`, 'POST', {
    title: 'Staged rollout', detail: 'Use a staged rollout with a rollback checkpoint.', blockIds: [], assignee: 'Manual release owner' });
  world.reflexSource = await request(world, `/canvases/${world.canvasId}/blocks`, 'POST', {
    title: 'Release decision', kind: 'markdown', content: sourceContent, tags: ['release'] });
  world.reflexReference = await request(world, `/canvases/${world.canvasId}/blocks`, 'POST', {
    title: 'Release reference', kind: 'markdown', content: referenceContent, tags: ['release'] });
}

When('related sources and existing rollout work are saved through the ordinary API', async function () {
  await saveRolloutSources(this);
});
When('distinct rollout sources and existing work are saved through the ordinary API', async function () {
  await saveRolloutSources(this, sourceContent + '\nThe reference preserves rollback records after deployment.');
});

function completedActions(state, source, newerThan = new Set()) {
  return new Set(state.jobs.filter(job => job.state === 'completed' && !newerThan.has(job.id)
    && job.sources.some(snapshot => snapshot.blockId === source.id && snapshot.sourceGeneration === source.sourceGeneration))
    .map(job => job.request.action));
}

function settled(state) { return state.jobs.every(job => !['queued', 'running'].includes(job.state)); }
function assertAutomaticPolicy(state) {
  assert.deepEqual(Object.keys(state.settings.modes).sort(), [...retainedActions].sort());
  assert.ok(Object.values(state.settings.modes).every(mode => mode === 'auto'));
  assert.equal(state.settings.externalProcessing, true);
  assert.deepEqual(state.proposals.filter(proposal => proposal.state === 'pending'), []);
  assert.ok(state.jobs.every(job => retainedActions.includes(job.request.action)));
  assert.ok(state.proposals.every(proposal => retainedActions.includes(proposal.action)));
  for (const action of removedActions) assert.equal(state.settings.confidenceThresholds?.[action], undefined);
}

Then('all six Reflex actions finish without a request or an open panel', async function () {
  assert.equal(this.page, undefined);
  this.reflexState = await checked(this, state => settled(state)
    && retainedActions.every(action => completedActions(state, this.reflexSource).has(action))
    && retainedActions.every(action => completedActions(state, this.reflexReference).has(action)));
  assertAutomaticPolicy(this.reflexState);
  assert.ok(this.reflexState.receipts.some(receipt => receipt.automatic));
  this.reflexSavedSource = await request(this, sourceRoute(this));
  const profile = this.reflexState.profiles[`${this.canvasId}:${this.reflexSource.id}`];
  assertCurrentProfile(profile);
  assert.ok(this.reflexSavedSource.group);
  assert.equal(this.reflexSavedSource.content, sourceContent);
  const task = (await request(this, `/canvases/${this.canvasId}/tasks`)).find(item => item.id === this.reflexTask.id);
  assert.deepEqual(task, this.reflexTask, 'Automatic organization changed a manual task');
});

function assertCurrentProfile(profile) {
  assert.ok(profile.role);
  assert.ok(profile.keyPassages?.length > 0);
  assert.equal(profile.qualityRubric, undefined);
  assert.equal(profile.recall, undefined);
}

function independentAction(questionName) {
  if (/^label_\d+$/.test(questionName)) return 'label';
  return { role: 'profile', group: 'file', canvas: 'suggest_home_canvas' }[questionName];
}

Then('independent typed action questions share real provider requests without mixing their saved sources', async function () {
  const text = await readFile(join(this.dataDir, 'reflex-provider-requests.jsonl'), 'utf8');
  const calls = text.trim().split('\n').map(line => JSON.parse(line));
  const sources = [this.reflexSource, this.reflexReference];
  for (const source of sources) {
    const matching = calls.filter(call => {
      const sets = call.state.questionSets;
      if (!Array.isArray(sets)) return false;
      const actions = new Set();
      for (const [key, question] of Object.entries(call.questions)) {
        const indexed = /^(\d+)__(.+)$/.exec(key);
        assert.ok(indexed, `Missing isolated question index: ${key}`);
        const state = resolveSharedQuestionSources(sets[Number(indexed[1])], call.state.sourceStates);
        assert.ok(state, `Missing questionSets[${indexed[1]}]`);
        assert.ok(question.instructions.startsWith(`Use only questionSets[${indexed[1]}] as the state for this question.`));
        assert.ok(['choice', 'score', 'noul'].includes(question.type));
        const document = state.document ?? state.source;
        if (document?.id !== source.id) continue;
        assert.equal(document.title, source.title);
        const original = source.content.replace(/\s+/g, ' ');
        assert.ok(document.passages.length > 0);
        for (const passage of document.passages) assert.ok(original.includes(passage.text.replace(/\s+/g, ' ')),
          `Question ${key} used a passage outside its selected saved source`);
        const action = independentAction(indexed[2]);
        if (action) actions.add(action);
      }
      return ['profile', 'label', 'suggest_home_canvas'].every(action => actions.has(action));
    });
    assert.ok(matching.length > 0, `Independent initial action questions were not sent together for ${source.title}`);
    assert.equal((await request(this, `/canvases/${this.canvasId}/blocks/${source.id}`)).content, source.content);
  }
});

When('I open Reflex only to observe automatic results', async function () {
  this.reflexWriteRequests = [];
  this.reflexNetworkFailures = [];
  this.page.on('requestfailed', outgoing => this.reflexNetworkFailures.push({ url: outgoing.url(), error: outgoing.failure()?.errorText }));
  this.page.on('request', outgoing => {
    if (outgoing.method() !== 'GET' && /\/jev\//.test(new URL(outgoing.url()).pathname)) this.reflexWriteRequests.push(outgoing.url());
  });
  await this.page.getByRole('tab', { name: 'Symbi Reflex', exact: true }).click();
  await panel(this).getByRole('heading', { name: 'Jev works automatically', exact: true }).waitFor();
  await panel(this).getByText('Automatic findings and saved results', { exact: true }).click();
});

function noManualControls(world) {
  return Promise.all([
    panel(world).locator('textarea, select, form, .jev-composer').count(),
    panel(world).getByRole('button', { name: /^Settings$|^Apply$|^Run$|Apply proposal|Approve|Organize this canvas|Run suggested steps|Send request|Undo|Pause|Resume|Preview with Symbi Reflex/i }).count(),
    panel(world).getByRole('checkbox').count(),
    panel(world).getByRole('radio').count(),
  ]).then(counts => assert.deepEqual(counts, [0, 0, 0, 0]));
}

Then('the Reflex panel contains findings without action approval or mode controls', async function () {
  await panel(this).getByRole('region', { name: 'Automatic findings', exact: true }).locator('[data-proposal-id]').first().waitFor();
  await noManualControls(this);
  assert.deepEqual(this.reflexWriteRequests, []);
  assert.deepEqual(this.pageErrors, []);
});

When('I reload the automatic Reflex canvas', async function () {
  try {
    await this.page.reload({ waitUntil: 'networkidle' });
    await this.page.getByRole('tab', { name: 'Symbi Reflex', exact: true }).click();
    await panel(this).getByRole('heading', { name: 'Jev works automatically', exact: true }).waitFor();
  } catch (error) {
    const body = await this.page.locator('body').innerText({ timeout: 2000 }).catch(() => 'Body unavailable');
    assert.fail(`${error.message}\nURL: ${this.page.url()}\nPage errors: ${JSON.stringify(this.pageErrors)}\n` +
      `Network failures: ${JSON.stringify(this.reflexNetworkFailures)}\nBody: ${body.slice(0, 6000)}\nServer: ${this.serverOutput}`);
  }
});

function thresholds(world) { return panel(world).getByRole('region', { name: 'Automatic action thresholds', exact: true }); }
function thresholdInput(world, label) { return thresholds(world).getByRole('spinbutton', { name: `${label} confidence threshold`, exact: true }); }
async function assertThresholdControls(world) {
  assert.equal(await thresholds(world).getByRole('spinbutton').count(), 6);
  assert.equal(await panel(world).locator('input').count(), 6);
  assert.equal(await thresholds(world).locator('tbody tr').count(), 6);
  for (const label of actionLabels) assert.equal(await thresholdInput(world, label).count(), 1);
  for (const label of retiredActionLabels) assert.equal(await thresholdInput(world, label).count(), 0);
  await noManualControls(world);
}
Then('the primary Reflex tab has exactly six single confidence controls at seventy percent', async function () {
  await assertThresholdControls(this);
  for (const label of actionLabels) assert.equal(await thresholdInput(this, label).inputValue(), '70');
  assert.deepEqual(this.reflexWriteRequests, []);
  assert.deepEqual(this.pageErrors, []);
});
When('I change the {string} confidence threshold to {int} percent', async function (label, percent) {
  const input = thresholdInput(this, label);
  await input.fill(String(percent));
  const saved = this.page.waitForResponse(outgoing => outgoing.request().method() === 'PUT'
    && new URL(outgoing.url()).pathname === `/api/workspaces/${this.reflexWorkspaceId}/jev/settings`);
  await input.press('Tab');
  const result = await saved;
  assert.equal(result.status(), 200, await result.text());
  this.reflexThresholdChanges ??= {};
  this.reflexThresholdChanges[retainedActions[actionLabels.indexOf(label)]] = percent / 100;
});
Then('only those confidence thresholds save automatically without an apply action', async function () {
  const state = await request(this, stateRoute(this));
  for (const action of retainedActions) assert.equal(state.settings.confidenceThresholds[action], this.reflexThresholdChanges[action] ?? 0.7);
  assert.equal(this.reflexWriteRequests.length, 2);
  assert.ok(this.reflexWriteRequests.every(url => new URL(url).pathname.endsWith('/jev/settings')));
  await noManualControls(this);
  assert.deepEqual(this.pageErrors, []);
});
Then('the individual confidence thresholds survive API readback and browser reload', async function () {
  await assertThresholdControls(this);
  const state = await request(this, stateRoute(this));
  for (const [index, action] of retainedActions.entries()) {
    const cutoff = this.reflexThresholdChanges[action] ?? 0.7;
    assert.equal(state.settings.confidenceThresholds[action], cutoff);
    assert.equal(await thresholdInput(this, actionLabels[index]).inputValue(), String(cutoff * 100));
  }
  assert.equal(this.reflexWriteRequests.length, 2);
  assert.deepEqual(this.pageErrors, []);
});

Then('automatic classification and unchanged manual tasks survive reload', async function () {
  const source = await request(this, sourceRoute(this));
  assert.equal(source.content, sourceContent);
  assert.equal(source.group, this.reflexSavedSource.group);
  assert.deepEqual(source.tags, this.reflexSavedSource.tags);
  const state = await request(this, stateRoute(this));
  assertAutomaticPolicy(state);
  const profile = state.profiles[`${this.canvasId}:${this.reflexSource.id}`];
  assertCurrentProfile(profile);
  const tasks = await request(this, `/canvases/${this.canvasId}/tasks`);
  assert.deepEqual(tasks, [this.reflexTask], 'Reload changed a manual task');
  await noManualControls(this);
  assert.deepEqual(this.reflexWriteRequests, []);
  assert.deepEqual(this.pageErrors, []);
});

When('the saved source and existing work change through the ordinary API', async function () {
  this.reflexPreviousJobs = new Set(this.reflexState.jobs.map(job => job.id));
  this.reflexSource = await request(this, sourceRoute(this), 'PUT', {
    content: sourceContent + '\nThe rollback checkpoint must preserve the updated release evidence.' });
  this.reflexTask = await request(this, `/canvases/${this.canvasId}/tasks/${this.reflexTask.id}`, 'PUT', {
    detail: 'Use the updated release evidence for the staged rollout with a rollback checkpoint.' });
});

Then('all six Reflex actions refresh for the current source automatically', async function () {
  this.reflexRefreshedState = await checked(this, state => settled(state)
    && retainedActions.every(action => completedActions(state, this.reflexSource, this.reflexPreviousJobs).has(action)));
  assertAutomaticPolicy(this.reflexRefreshedState);
  const profile = this.reflexRefreshedState.profiles[`${this.canvasId}:${this.reflexSource.id}`];
  assert.equal(profile.source.sourceGeneration, this.reflexSource.sourceGeneration);
  assertCurrentProfile(profile);
});

Then('the refreshed results survive reload without additional tasks or approvals', async function () {
  const source = await request(this, sourceRoute(this));
  assert.equal(source.content, this.reflexSource.content);
  const state = await request(this, stateRoute(this));
  assertAutomaticPolicy(state);
  assert.equal(state.profiles[`${this.canvasId}:${source.id}`].source.sourceGeneration, source.sourceGeneration);
  const tasks = await request(this, `/canvases/${this.canvasId}/tasks`);
  assert.deepEqual(tasks, [this.reflexTask], 'Refreshed organization changed manually updated work');
  await noManualControls(this);
  assert.deepEqual(this.reflexWriteRequests, []);
  assert.deepEqual(this.pageErrors, []);
});

async function completedKnowledge(world, state) {
  return { jobs: state.jobs, proposals: state.proposals, receipts: state.receipts, profiles: state.profiles,
    vocabulary: state.vocabulary, sources: await workspaceSources(world),
    tasks: await request(world, `/canvases/${world.canvasId}/tasks`) };
}

Then('I record the completed automatic knowledge and its job history', async function () {
  const sources = [this.reflexSource, this.reflexReference];
  const state = await checked(this, state => settled(state) && sources.every(source =>
    Object.values(state.profiles).some(profile => profile.source?.blockId === source.id && profile.organizationContextKey)));
  assertAutomaticPolicy(state);
  assert.equal(settled(state), true);
  this.reflexCompletedKnowledge = await completedKnowledge(this, state);
  assert.ok(this.reflexCompletedKnowledge.vocabulary.every(term => term.kind === 'group'),
    'Filing may define groups; removed vocabulary maintenance must not create labels or entities');
});

When('I save the unchanged automatic settings through three reconciliation passes', async function () {
  for (let pass = 0; pass < 3; pass += 1) {
    await request(this, `/workspaces/${this.reflexWorkspaceId}/jev/settings`, 'PUT', {});
    const state = await request(this, stateRoute(this));
    assert.deepEqual(await completedKnowledge(this, state), this.reflexCompletedKnowledge,
      `Unchanged completed knowledge restarted during reconciliation pass ${pass + 1}`);
  }
});

Then('completed sources and their automatic results have not restarted or changed', async function () {
  const state = await request(this, stateRoute(this));
  assertAutomaticPolicy(state);
  assert.equal(settled(state), true);
  assert.deepEqual(await completedKnowledge(this, state), this.reflexCompletedKnowledge);
  if (this.page) {
    await noManualControls(this);
    assert.deepEqual(this.reflexWriteRequests, []);
    assert.deepEqual(this.pageErrors, []);
  }
});

When('every removed Reflex action and command recipe is submitted through HTTP', async function () {
  this.reflexRemovedResponses = await Promise.all(removedActions.map(async action => ({ action,
    status: (await response(this, `/canvases/${this.canvasId}/jev/actions`, 'POST', { action })).status })));
  this.reflexCommandStatus = (await response(this, `/workspaces/${this.reflexWorkspaceId}/jev/commands`, 'POST', {
    canvasId: this.canvasId, recipe: 'organize' })).status;
});

Then('all twenty-one removed actions return bad requests and commands return not found', function () {
  assert.equal(this.reflexRemovedResponses.length, 21);
  assert.deepEqual(this.reflexRemovedResponses.filter(result => result.status !== 400), []);
  assert.equal(this.reflexCommandStatus, 404);
});

When('manual organization is saved and automatic processing is paused with another workspace canvas', async function () {
  await request(this, `/workspaces/${this.reflexWorkspaceId}/jev/settings`, 'PUT', {
    paused: true, confidenceThresholds: { profile: 0.85, file: 0.8 } });
  this.reflexSource = await request(this, sourceRoute(this), 'PUT', {
    group: 'custom:manual', tags: ['Manual'], reviewer: 'Human reviewer', x: 321, y: 654 });
  const canvas = await request(this, `/workspaces/${this.reflexWorkspaceId}/canvases`, 'POST', { name: 'Additional rollout knowledge' });
  this.reflexResetRemoteCanvasId = canvas.id;
  this.reflexResetRemote = await request(this, `/canvases/${canvas.id}/blocks`, 'POST', {
    title: 'Remote rollback checkpoint', kind: 'markdown', content: '# Rollback checkpoint\nBen owns the staged rollout.\nKeep the rollback checkpoint available before releasing.',
    group: 'custom:manual-remote', tags: ['Manual remote'], x: 123, y: 456 });
  this.reflexResetManualSource = await request(this, sourceRoute(this));
  assert.equal(this.reflexResetManualSource.x, 321); assert.equal(this.reflexResetManualSource.y, 654);
  assert.equal(this.reflexResetRemote.x, 123); assert.equal(this.reflexResetRemote.y, 456);
  this.reflexResetReferenceContent = (await request(this, `/canvases/${this.canvasId}/blocks/${this.reflexReference.id}`)).content;
});

Then('Reflex reports paused processing and offers the workspace reset', async function () {
  await panel(this).getByText('Automatic processing is paused.', { exact: true }).waitFor();
  const button = panel(this).getByRole('button', { name: 'Reset all Jev', exact: true });
  assert.equal(await button.isEnabled(), true);
  await panel(this).getByText('Across this workspace, clears Jev-generated analysis and organization, then runs all 6 actions. Manual changes and source content remain.', { exact: true }).waitFor();
  assert.deepEqual(this.reflexWriteRequests, []);
  assert.deepEqual(this.pageErrors, []);
});

When('I reset and rerun Jev from Reflex', async function () {
  const before = await request(this, stateRoute(this));
  this.reflexResetPreviousJobs = new Set(before.jobs.map(job => job.id));
  this.reflexResetCount = (this.reflexResetCount ?? 0) + 1;
  const completed = this.page.waitForResponse(outgoing => outgoing.request().method() === 'POST'
    && new URL(outgoing.url()).pathname === `/api/workspaces/${this.reflexWorkspaceId}/jev/reset`);
  await panel(this).getByRole('button', { name: 'Reset all Jev', exact: true }).click();
  const result = await completed;
  assert.equal(result.status(), 200, await result.text());
  await panel(this).getByText('Jev-generated results cleared. Automatic checks restarted across this workspace.', { exact: true }).waitFor();
});

async function workspaceSources(world) {
  const workspaces = await request(world, '/workspaces');
  const workspace = workspaces.find(item => item.id === world.reflexWorkspaceId);
  const canvases = await Promise.all(workspace.canvases.map(canvas => request(world, `/canvases/${canvas.id}`)));
  return canvases.flatMap(canvas => canvas.blocks);
}

function assertManualSource(source, before) {
  for (const field of ['title', 'content', 'contentHash', 'sourceGeneration', 'kind', 'x', 'y', 'width', 'height', 'group', 'tags', 'reviewer']) {
    assert.deepEqual(source[field], before[field], `Reset changed manual source ${field}`);
  }
}

async function assertResetPersistence(world, state) {
  assertAutomaticPolicy(state);
  assert.equal(state.hasApiKey, true);
  assert.equal(state.settings.paused, false);
  assert.equal(state.settings.confidenceThresholds.profile, 0.85);
  assert.equal(state.settings.confidenceThresholds.file, 0.8);
  const sources = await workspaceSources(world);
  assert.equal(sources.length, 3);
  const source = sources.find(block => block.id === world.reflexSource.id);
  const remote = sources.find(block => block.id === world.reflexResetRemote.id);
  assertManualSource(source, world.reflexResetManualSource);
  assertManualSource(remote, world.reflexResetRemote);
  assert.equal(sources.find(block => block.id === world.reflexReference.id).content, world.reflexResetReferenceContent);
  for (const block of sources) {
    const profile = Object.values(state.profiles).find(value => value.source?.blockId === block.id);
    assert.ok(profile, `Reset did not rebuild profile ${block.id}`);
    assertCurrentProfile(profile);
  }
  const tasks = await request(world, `/canvases/${world.canvasId}/tasks`);
  assert.deepEqual(tasks, [world.reflexTask], 'Reset changed a manual task');
  const resetRequests = world.reflexWriteRequests.filter(url => new URL(url).pathname.endsWith('/jev/reset'));
  assert.equal(resetRequests.length, world.reflexResetCount);
  assert.equal(world.reflexWriteRequests.length, world.reflexResetCount);
  await noManualControls(world);
  assert.deepEqual(world.pageErrors, []);
}

Then('all six actions rerun for every workspace source while manual knowledge and settings remain', async function () {
  const selected = [this.reflexSource, this.reflexReference, this.reflexResetRemote];
  this.reflexResetState = await checked(this, state => settled(state)
    && state.jobs.every(job => !this.reflexResetPreviousJobs.has(job.id))
    && selected.every(source => retainedActions.every(action => completedActions(state, source).has(action))));
  await assertResetPersistence(this, this.reflexResetState);
});

Then('the reset results and confidence settings survive browser reload', async function () {
  await assertResetPersistence(this, await request(this, stateRoute(this)));
  await assertThresholdControls(this);
  assert.equal(await thresholdInput(this, 'Understand documents').inputValue(), '85');
  assert.equal(await thresholdInput(this, 'Organize into groups').inputValue(), '80');
  assert.equal(await panel(this).getByRole('button', { name: 'Reset all Jev', exact: true }).isEnabled(), true);
});

Then('Reflex reports the missing provider key without requesting action approval', async function () {
  await panel(this).getByText('Waiting for a TypeSafe API key in Settings.', { exact: true }).waitFor();
  const state = await request(this, stateRoute(this));
  assert.equal(state.hasApiKey, false); assert.deepEqual(state.jobs, []);
  assertAutomaticPolicy(state);
  await noManualControls(this);
  assert.deepEqual(this.reflexWriteRequests, []);
  assert.deepEqual(this.pageErrors, []);
});

Then('the workspace reset is disabled without a provider and makes no request', async function () {
  const button = panel(this).getByRole('button', { name: 'Reset all Jev', exact: true });
  assert.equal(await button.isDisabled(), true);
  await panel(this).getByText('A connected TypeSafe key and automatic processing are required to reset and rerun Jev.', { exact: true }).waitFor();
  await button.evaluate(element => element.click());
  assert.deepEqual(this.reflexWriteRequests, []);
  assert.deepEqual(this.pageErrors, []);
});
