import { strict as assert } from 'node:assert';
import { Then, When } from '@cucumber/cucumber';

async function request(world, route, method = 'GET', body) {
  const response = await fetch(`${world.baseUrl}${route}`, { method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

When('I request Jev analysis for one document card', async function () {
  const canvas = await request(this, `/api/canvases/${this.canvasId}`);
  assert.equal(canvas.status, 200);
  this.targetedCanvasCount = canvas.body.blocks.length;
  const blockId = canvas.body.blocks[0].id;
  this.targetedJevResult = await request(this, `/api/canvases/${this.canvasId}/insights`, 'POST',
    { query: '', blockIds: [blockId], families: ['purpose', 'work_area'] });
});

Then('Jev reports only that document as analyzed', function () {
  assert.equal(this.targetedJevResult.status, 200, JSON.stringify(this.targetedJevResult.body));
  assert.equal(this.targetedJevResult.body.analyzed, 1);
  assert.equal(this.targetedJevResult.body.total, this.targetedCanvasCount);
});

When('I request an unsupported Jev question family', async function () {
  this.invalidTargetedJevResult = await request(this, `/api/canvases/${this.canvasId}/insights`, 'POST',
    { query: '', families: ['unsupported'] });
});

Then('the targeted Jev request is rejected', function () {
  assert.equal(this.invalidTargetedJevResult.status, 400);
  assert.match(this.invalidTargetedJevResult.body.error, /families/i);
});

When('I preview Jev intake for a new guide', async function () {
  const before = await request(this, `/api/canvases/${this.canvasId}`);
  this.intakeBlockCount = before.body.blocks.length;
  this.intakeResult = await request(this, `/api/canvases/${this.canvasId}/intake/preview`, 'POST',
    { title: 'Draft setup guide', content: '# Draft setup guide\nInstall and configure the app.', kind: 'markdown' });
});

Then('the intake preview has provenance and has saved no document', async function () {
  assert.equal(this.intakeResult.status, 200, JSON.stringify(this.intakeResult.body));
  assert.ok(this.intakeResult.body.canvasId);
  assert.ok(this.intakeResult.body.evidence.some(item => item.questionId === 'intake_canvas' && item.model));
  const after = await request(this, `/api/canvases/${this.canvasId}`);
  assert.equal(after.body.blocks.length, this.intakeBlockCount);
});

When('I preview intake with a related document and known tag', async function () {
  const canvas = await request(this, `/api/canvases/${this.canvasId}`);
  assert.equal(canvas.status, 200);
  const related = canvas.body.blocks[0];
  this.relatedBlockId = related.id;
  this.intakeDraft = { title: `${related.title} guide`,
    content: `# ${related.title} guide\n${related.content.slice(0, 300)}`, kind: 'markdown' };
  const settings = await request(this, '/api/settings', 'PUT', { tagVocabulary: 'roadmap' });
  assert.equal(settings.status, 200);
  this.acceptedIntakeBeforeCount = canvas.body.blocks.length;
  this.acceptedIntake = await request(this, `/api/canvases/${this.canvasId}/intake/preview`, 'POST', this.intakeDraft);
  assert.equal(this.acceptedIntake.status, 200, JSON.stringify(this.acceptedIntake.body));
});

When('I save the document with its accepted intake suggestions', async function () {
  const suggestion = this.acceptedIntake.body;
  assert.equal(suggestion.canvasId, this.canvasId);
  assert.ok(suggestion.purpose);
  assert.ok(suggestion.workArea);
  assert.ok(suggestion.tags.length);
  assert.ok(suggestion.linkTargets.some(item => item.blockId === this.relatedBlockId));
  this.intakeSaved = await request(this, `/api/canvases/${suggestion.canvasId}/blocks`, 'POST', {
    ...this.intakeDraft, purpose: suggestion.purpose, workArea: suggestion.workArea,
    tags: suggestion.tags, links: suggestion.linkTargets.map(item => item.blockId),
  });
  assert.equal(this.intakeSaved.status, 201, JSON.stringify(this.intakeSaved.body));
});

Then('one new document keeps its suggested labels tag and link after reloading', async function () {
  const canvas = await request(this, `/api/canvases/${this.canvasId}`);
  assert.equal(canvas.status, 200);
  assert.equal(canvas.body.blocks.length, this.acceptedIntakeBeforeCount + 1);
  const saved = canvas.body.blocks.find(item => item.id === this.intakeSaved.body.id);
  assert.ok(saved);
  assert.equal(saved.purpose, this.acceptedIntake.body.purpose);
  assert.equal(saved.workArea, this.acceptedIntake.body.workArea);
  assert.deepEqual(saved.tags, this.acceptedIntake.body.tags);
  assert.deepEqual(saved.links, [this.relatedBlockId]);
});

When('I open the Jev review inbox', async function () {
  this.jevInboxResult = await request(this, `/api/canvases/${this.canvasId}/jev-inbox`);
});

Then('the inbox reports checked and pending documents', function () {
  assert.equal(this.jevInboxResult.status, 200, JSON.stringify(this.jevInboxResult.body));
  assert.ok(this.jevInboxResult.body.checkedBlockIds.length <= 2);
  assert.ok(this.jevInboxResult.body.pendingBlockIds.length > 0);
  assert.deepEqual(this.jevInboxResult.body.errors, []);
});
