import { strict as assert } from 'node:assert';
import { Then, When } from '@cucumber/cucumber';

async function request(world, path, method = 'GET', body) {
  const response = await fetch(`${world.baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function canvas(world) {
  const result = await request(world, `/api/canvases/${world.canvasId}`);
  assert.equal(result.status, 200);
  return result.body;
}

When('I configure Jev for canvas run review', async function () {
  const result = await request(this, '/api/settings', 'PUT', {
    model: 'openai/gpt-4o-mini', jevApiKey: 'acceptance-placeholder',
  });
  assert.equal(result.status, 200);
});

When('I preview work-area labels on the current canvas', async function () {
  this.canvasBeforeRun = await canvas(this);
  const result = await request(this, `/api/canvases/${this.canvasId}/automations`, 'POST', {
    kind: 'work_area', dryRun: true,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.dryRun, true);
  assert.equal(result.body.canvasId, this.canvasId);
  assert.ok(result.body.changes.length > 0);
  this.canvasRunPreview = result.body;
  this.selectedCanvasChange = result.body.changes[0];
  assert.equal(this.selectedCanvasChange.action.type, 'update');
});

Then('the canvas run preview leaves labels unchanged', async function () {
  assert.deepEqual((await canvas(this)).blocks.map(block => block.workArea),
    this.canvasBeforeRun.blocks.map(block => block.workArea));
});

When('I apply one selected canvas change', async function () {
  const result = await request(this, `/api/canvases/${this.canvasId}/automations`, 'POST', {
    kind: 'work_area', dryRun: false, runId: this.canvasRunPreview.runId,
    actionIds: [this.selectedCanvasChange.id],
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  this.canvasRunApplied = result.body;
});

Then('only the selected canvas change is saved', async function () {
  assert.deepEqual(this.canvasRunApplied.applied, [this.selectedCanvasChange.id]);
  const before = new Map(this.canvasBeforeRun.blocks.map(block => [block.id, block.workArea]));
  const changed = (await canvas(this)).blocks.filter(block => block.workArea !== before.get(block.id));
  assert.deepEqual(changed.map(block => block.id), [this.selectedCanvasChange.action.blockId]);
});

When('I undo the selected canvas run', async function () {
  const result = await request(this, `/api/jev-runs/${this.canvasRunPreview.runId}/undo`, 'POST');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.reverted, [this.selectedCanvasChange.id]);
});

Then('the canvas run restores original labels', async function () {
  assert.deepEqual((await canvas(this)).blocks.map(block => block.workArea),
    this.canvasBeforeRun.blocks.map(block => block.workArea));
});

When('I edit the selected document after its preview', async function () {
  const action = this.selectedCanvasChange.action;
  const result = await request(this, `/api/canvases/${this.canvasId}/blocks/${action.blockId}`, 'PUT', {
    content: '# Changed after preview',
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
});

Then('the canvas run reports the stale document and keeps its label', async function () {
  assert.deepEqual(this.canvasRunApplied.applied, []);
  assert.deepEqual(this.canvasRunApplied.skipped, [
    { id: this.selectedCanvasChange.id, reason: 'Document changed since preview' },
  ]);
  const before = this.canvasBeforeRun.blocks.find(block => block.id === this.selectedCanvasChange.action.blockId);
  const after = (await canvas(this)).blocks.find(block => block.id === this.selectedCanvasChange.action.blockId);
  assert.equal(after.workArea, before.workArea);
});
