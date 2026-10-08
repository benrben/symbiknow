import { strict as assert } from 'node:assert';
import { expect } from 'playwright/test';
import { When, Then } from '@cucumber/cucumber';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProjectMcpServer } from '../../server/mcp.ts';

const plans = [
  { title: 'Review release', priority: 'urgent', size: 'xl', dueDate: '2030-10-09', status: 'todo' },
  { title: 'Small follow-up', priority: 'low', size: 'xs', dueDate: '2030-10-08', status: 'blocked' },
  { title: 'Plan rollout', priority: 'high', size: 'm', dueDate: '2030-10-07', status: 'in_progress' },
];

async function todos(world) {
  const response = await fetch(`${world.baseUrl}/api/canvases/${world.canvasId}/todos`);
  assert.equal(response.status, 200);
  return response.json();
}

async function mcp(world, name, args) {
  const server = createProjectMcpServer(`${world.baseUrl}/api`);
  const client = new Client({ name: 'todo-browser-acceptance', version: '1.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const response = await client.callTool({ name, arguments: { canvasId: world.canvasId, ...args } });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  } finally { await client.close(); await server.close(); }
}

When('I open the canvas task view', async function () {
  await this.page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await this.page.locator('.todo-canvas').waitFor();
});

When('I add three tasks with different priorities dates and sizes', async function () {
  for (const task of plans) {
    await this.page.getByRole('button', { name: 'New task', exact: true }).click();
    const form = this.page.locator('.todo-form-panel');
    await form.getByLabel('Task title').fill(task.title);
    await form.getByLabel('Description').fill('Keep the release moving.');
    await form.getByLabel('Priority', { exact: true }).selectOption(task.priority);
    await form.getByLabel('Size', { exact: true }).selectOption(task.size);
    await form.getByLabel('Due date').fill(task.dueDate);
    await form.getByLabel('Status', { exact: true }).selectOption(task.status);
    await form.getByLabel('Assignee').fill('Team');
    await form.getByRole('button', { name: 'Save task', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
  }
  const saved = await todos(this);
  assert.equal(saved.length, 3);
  for (const task of plans) assert.ok(saved.some(item => item.title === task.title && item.size === task.size && item.dueDate === task.dueDate));
});

Then('priority date and size sorting change the task order', async function () {
  for (const [sort, expected] of [
    ['priority', ['Review release', 'Plan rollout', 'Small follow-up']],
    ['due', ['Plan rollout', 'Small follow-up', 'Review release']],
    ['size', ['Small follow-up', 'Plan rollout', 'Review release']],
  ]) {
    await this.page.getByLabel('Sort tasks').selectOption(sort);
    await expect(this.page.locator('.todo-item strong')).toHaveText(expected);
  }
  await this.page.getByLabel('Search tasks').fill('follow-up');
  await expect(this.page.locator('.todo-item strong')).toHaveText(['Small follow-up']);
  await this.page.getByLabel('Search tasks').fill('');
  await expect(this.page.locator('.todo-item strong')).toHaveCount(3);
  await this.page.screenshot({ path: '/tmp/symbiknow-todos-list.png' });
  await this.page.setViewportSize({ width: 390, height: 844 });
  await expect(this.page.locator('.chat-panel')).toBeHidden();
  await expect(this.page.getByRole('button', { name: 'Back to canvas', exact: true })).toBeVisible();
  await expect(this.page.getByRole('button', { name: 'New task', exact: true })).toBeVisible();
  assert.ok(await this.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await this.page.screenshot({ path: '/tmp/symbiknow-todos-mobile.png' });
  await this.page.setViewportSize({ width: 1440, height: 900 });
  assert.deepEqual(this.pageErrors, []);
});

When('I switch the tasks to a status board', async function () {
  await this.page.getByRole('button', { name: 'Board view' }).click();
});

Then('the tasks appear in their status columns', async function () {
  for (const [status, title] of [['To do', 'Review release'], ['In progress', 'Plan rollout'], ['Blocked', 'Small follow-up']]) {
    await this.page.getByRole('region', { name: status, exact: true }).getByText(title, { exact: true }).waitFor();
  }
  await this.page.screenshot({ path: '/tmp/symbiknow-todos-board.png' });
  await this.page.getByRole('button', { name: 'Switch to dark mode' }).click();
  assert.equal(await this.page.locator('html').getAttribute('data-theme'), 'dark');
  await this.page.screenshot({ path: '/tmp/symbiknow-todos-dark.png' });
  await this.page.getByRole('button', { name: 'Switch to light mode' }).click();
  await this.page.getByRole('button', { name: 'List view' }).click();
});

When('I complete a task and reload the task view', async function () {
  await this.page.getByRole('button', { name: 'Complete Review release', exact: true }).click();
  await this.page.getByRole('button', { name: 'Edit Review release', exact: true }).waitFor({ state: 'hidden' });
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.locator('.todo-canvas').waitFor();
});

Then('the completed task is archived with its details', async function () {
  assert.equal(await this.page.getByRole('button', { name: 'Edit Review release', exact: true }).count(), 0);
  await this.page.getByRole('button', { name: /^Archive 1$/ }).click();
  const row = this.page.locator('.todo-item', { hasText: 'Review release' });
  await row.waitFor();
  assert.ok((await row.innerText()).includes('XL'));
  const saved = (await todos(this)).find(task => task.title === 'Review release');
  assert.equal(saved.status, 'done');
  assert.equal(saved.assignee, 'Team');
  assert.equal(saved.detail, 'Keep the release moving.');
  assert.deepEqual(this.pageErrors, []);
});

When('I restore the archived task', async function () {
  await this.page.getByRole('button', { name: 'Restore Review release', exact: true }).click();
  await this.page.getByRole('button', { name: 'Restore Review release', exact: true }).waitFor({ state: 'hidden' });
  await this.page.getByRole('button', { name: /^Active 3$/ }).click();
});

Then('it returns to active work and survives reload', async function () {
  await this.page.getByRole('button', { name: 'Complete Review release', exact: true }).waitFor();
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Complete Review release', exact: true }).waitFor();
  assert.equal((await todos(this)).find(task => task.title === 'Review release').status, 'todo');
  await this.page.getByRole('button', { name: 'Back to canvas', exact: true }).click();
  await this.page.locator('.canvas-surface').waitFor();
  assert.deepEqual(this.pageErrors, []);
});

When('an MCP agent creates a canvas todo', async function () {
  this.agentTodo = await mcp(this, 'create_todo', { title: 'Agent task', priority: 'high', size: 's', status: 'in_progress' });
});

When('I draft a task edit before an MCP agent changes it', async function () {
  await this.page.getByRole('button', { name: 'Edit Agent task', exact: true }).click();
  await this.page.getByLabel('Task title').fill('My retained draft');
  this.agentTodo = await mcp(this, 'update_todo', { taskId: this.agentTodo.id, expectedRevision: this.agentTodo.revision, title: 'Agent changed title' });
  await this.page.getByRole('button', { name: 'Save task', exact: true }).click();
});

Then('saving the stale edit preserves both the agent change and my draft', async function () {
  await this.page.getByRole('alert').waitFor();
  assert.equal(await this.page.getByLabel('Task title').inputValue(), 'My retained draft');
  assert.equal((await todos(this))[0].title, 'Agent changed title');
  assert.deepEqual(this.pageErrors, []);
});

When('I refresh tasks and retry my draft', async function () {
  await this.page.getByRole('button', { name: 'Retry / refresh tasks', exact: true }).click();
  await this.page.getByRole('button', { name: 'Edit Agent changed title', exact: true }).waitFor();
  assert.equal(await this.page.getByLabel('Task title').inputValue(), 'My retained draft');
  await this.page.getByRole('button', { name: 'Save task', exact: true }).click();
  await this.page.locator('.todo-form-panel').waitFor({ state: 'hidden' });
});

Then('the retried edit is saved and readable by MCP', async function () {
  const saved = await mcp(this, 'list_todos', {});
  this.agentTodo = saved[0];
  assert.equal(this.agentTodo.title, 'My retained draft');
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Edit My retained draft', exact: true }).waitFor();
});

When('an MCP agent marks the todo done', async function () {
  this.agentTodo = await mcp(this, 'set_todo_status', { taskId: this.agentTodo.id, expectedRevision: this.agentTodo.revision, status: 'done' });
});

Then('the browser shows the agent completed todo in Archive', async function () {
  await this.page.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
  await this.page.getByRole('button', { name: /^Archive 1$/ }).click();
  await this.page.getByRole('button', { name: 'Restore My retained draft', exact: true }).waitFor();
  assert.equal(this.agentTodo.status, 'done');
  assert.deepEqual(this.pageErrors, []);
});
