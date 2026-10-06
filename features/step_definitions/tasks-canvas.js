import { strict as assert } from 'node:assert';
import { Then, When } from '@cucumber/cucumber';

async function tasks(world) {
  const response = await fetch(`${world.baseUrl}/api/canvases/${world.canvasId}/tasks`);
  assert.equal(response.status, 200);
  return response.json();
}

When('I open the Tasks canvas page', async function () {
  await this.page.getByRole('button', { name: 'Open Tasks page' }).click();
  await this.page.getByRole('region', { name: 'Tasks canvas board' }).waitFor();
});

Then('the four task status columns are visible in order', async function () {
  const columns = await this.page.locator('[data-task-column]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-task-column')));
  assert.deepEqual(columns, ['todo', 'in_progress', 'blocked', 'done']);
});

When('I create a task called {string} in the Blocked column', async function (title) {
  const canvas = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}`).then(response => response.json());
  this.documentPositions = canvas.blocks.map(block => ({ id: block.id, x: block.x, y: block.y, group: block.group }));
  await this.page.getByRole('button', { name: 'Add task in Blocked' }).click();
  const form = this.page.locator('.task-canvas-create');
  await form.getByLabel('Title').fill(title);
  await form.getByRole('button', { name: 'Create task' }).click();
  await this.page.getByRole('button', { name: `Open task ${title}` }).waitFor();
  await this.page.getByRole('button', { name: 'Close task details' }).click();
});

Then('the task is durable in Blocked', async function () {
  const saved = await tasks(this);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'blocked');
  this.taskId = saved[0].id;
});

When('I drag {string} to the Done column', async function (title) {
  this.taskWrites = [];
  this.page.on('request', request => { if (request.method() === 'PUT' && /\/tasks\//.test(request.url())) this.taskWrites.push(request.postData()); });
  const card = this.page.getByRole('button', { name: `Open task ${title}` });
  const target = this.page.locator('[data-task-column="done"]');
  await card.dragTo(target, { targetPosition: { x: 100, y: 135 }, sourcePosition: { x: 120, y: 55 } });
});

Then('the task is durable in Done and document positions are unchanged', async function () {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    this.savedAfterDrag = await tasks(this);
    if (this.savedAfterDrag.find(task => task.id === this.taskId)?.status === 'done') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(this.savedAfterDrag.find(task => task.id === this.taskId)?.status, 'done', JSON.stringify({ writes: this.taskWrites, saved: this.savedAfterDrag }));
  const canvas = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}`).then(response => response.json());
  assert.deepEqual(canvas.blocks.map(block => ({ id: block.id, x: block.x, y: block.y, group: block.group })), this.documentPositions);
});

When('I reload the Tasks canvas page', async function () {
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Open Tasks page' }).click();
  await this.page.getByRole('region', { name: 'Tasks canvas board' }).waitFor();
});

Then('the task remains in Done with no browser errors', async function () {
  await this.page.getByRole('button', { name: 'Open task Review release' }).waitFor();
  const saved = await tasks(this);
  assert.equal(saved.find(task => task.id === this.taskId)?.status, 'done', JSON.stringify({ writes: this.taskWrites, afterDrag: this.savedAfterDrag, afterReload: saved }));
  assert.deepEqual(this.pageErrors, []);
});

When('I create three ordered tasks on the current canvas', async function () {
  for (const [index, title] of ['Task A', 'Task B', 'Task C'].entries()) {
    const response = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, status: 'todo', boardOrder: (index + 1) * 1000 }),
    });
    assert.equal(response.status, 201);
  }
});

When('I drag the last task before the first task in To do', async function () {
  const card = this.page.getByRole('button', { name: 'Open task Task C' });
  const column = this.page.locator('[data-task-column="todo"]');
  const source = await card.boundingBox();
  const target = await column.boundingBox();
  assert.ok(source && target);
  await this.page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await this.page.mouse.down();
  await this.page.mouse.move(target.x + 100, target.y + 75, { steps: 12 });
  await this.page.mouse.up();
});

Then('the task order is saved and remains after reloading the board', async function () {
  const check = async () => (await tasks(this)).filter(task => task.status === 'todo')
    .sort((a, b) => a.boardOrder - b.boardOrder).map(task => task.title);
  let order = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    order = await check();
    if (order[0] === 'Task C') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(order, ['Task C', 'Task A', 'Task B']);
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Open Tasks page' }).click();
  await this.page.getByRole('button', { name: 'Open task Task C' }).waitFor();
  assert.deepEqual(await check(), ['Task C', 'Task A', 'Task B']);
  assert.deepEqual(this.pageErrors, []);
});
