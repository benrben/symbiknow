import { strict as assert } from 'node:assert';
import { Then, When } from '@cucumber/cucumber';

Then('the retired Tasks view and API are unavailable', async function () {
  assert.equal(await this.page.getByRole('button', { name: 'Open Tasks page' }).count(), 0);
  await this.page.goto(`${this.baseUrl}/?canvas=${this.canvasId}&view=tasks`);
  await this.page.locator('.canvas-surface').waitFor();
  await this.page.waitForURL(url => !url.searchParams.has('view'));
  assert.equal(new URL(this.page.url()).searchParams.has('view'), false);
  assert.equal(await this.page.getByRole('button', { name: 'Open Tasks page' }).count(), 0);
  for (const [method, suffix] of [['GET', ''], ['POST', ''], ['PUT', '/removed'], ['DELETE', '/removed']]) {
    const result = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}/tasks${suffix}`, { method,
      ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: '{}' }) });
    assert.equal(result.status, 404, `${method} ${suffix}`);
  }
  assert.deepEqual(this.pageErrors, []);
});

Then('the ordinary app is visible without Jev action controls', async function () {
  assert.equal(await this.page.locator('.canvas-surface').count(), 1);
  await this.page.locator('.canvas-card', { hasText: 'Ordinary Note' }).waitFor();
  for (const name of [/^Insights$/, /^Analyze canvas$/, /^Find duplicates$/, /^Organize with Jev$/]) {
    assert.equal(await this.page.getByRole('button', { name }).count(), 0);
  }
  assert.deepEqual(this.pageErrors, []);
});

When('I open the restored chat and settings without a Tasks tab', async function () {
  const search = this.page.getByRole('dialog', { name: 'Search documents', exact: true });
  if (await search.isVisible()) {
    await search.getByRole('button', { name: 'Close search', exact: true }).click();
    await search.waitFor({ state: 'hidden' });
  }
  if (!await this.page.getByRole('tab', { name: 'Chat', exact: true }).isVisible()) {
    await this.page.getByRole('button', { name: /^Toggle Symbi$/ }).first().click();
  }
  await this.page.getByRole('tab', { name: 'Chat', exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await this.page.getByRole('tab', { name: 'Tasks', exact: true }).count(), 0);
  await this.page.getByRole('tab', { name: 'Symbi Reflex', exact: true }).waitFor();
  assert.equal(await this.page.getByRole('tab', { name: 'Insights', exact: true }).count(), 0);
  await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
});

Then('ordinary settings remain without Jev action settings', async function () {
  const dialog = this.page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('heading', { name: 'Connections and agents', exact: true }).waitFor();
  assert.ok(await this.page.getByRole('button', { name: /^Models$/ }).count() > 0);
  assert.equal(await this.page.getByText('TypeSafe Jev', { exact: true }).count(), 0);
  assert.equal(await this.page.getByLabel(/Jev API key|Review teams|Extra work-area labels/).count(), 0);
  assert.deepEqual(this.pageErrors, []);
});

When('I request the removed Jev action endpoints', async function () {
  const routes = [
    ['POST', `/api/canvases/${this.canvasId}/insights`],
    ['GET', `/api/canvases/${this.canvasId}/jev-inbox`],
    ['POST', `/api/canvases/${this.canvasId}/intake/preview`],
    ['POST', `/api/canvases/${this.canvasId}/automations`],
    ['POST', `/api/canvases/${this.canvasId}/duplicates`],
    ['POST', `/api/canvases/${this.canvasId}/quality`],
    ['GET', `/api/canvases/${this.canvasId}/tasks/insights`],
    ['GET', '/api/jev/usage'], ['GET', '/api/jev/calibration'],
  ];
  this.removedRoutes = [];
  for (const [method, route] of routes) {
    const response = await fetch(this.baseUrl + route, { method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    this.removedRoutes.push({ route, status: response.status, body: await response.json() });
  }
});
Then('every removed Jev action returns not found', function () {
  assert.equal(this.removedRoutes.length, 9);
  for (const result of this.removedRoutes) {
    assert.equal(result.status, 404, result.route);
    assert.equal(result.body.error, 'Route not found');
  }
});

When('I upload a plain document without Jev suggestions', async function () {
  this.actionRequests = [];
  this.page.on('request', request => {
    if (/\/api\/.*(?:\/insights|\/jev|\/intake\/preview|\/automations|\/duplicates|\/quality)/.test(request.url())) this.actionRequests.push(request.url());
  });
  await this.page.locator('input[type="file"]').first().setInputFiles({
    name: 'plain-restored-note.md', mimeType: 'text/markdown', buffer: Buffer.from('# Restored plain note\nNo analysis is needed.'),
  });
  await this.page.locator('.canvas-card', { hasText: 'plain-restored-note' }).waitFor();
});
Then('the uploaded document survives reload without a Jev request', async function () {
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Search documents', exact: true }).click();
  await this.page.getByPlaceholder('Search every Markdown file…').fill('plain-restored-note');
  await this.page.getByRole('button', { name: 'Show plain-restored-note on canvas', exact: true }).click();
  const response = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}`);
  const canvas = await response.json();
  const block = canvas.blocks.find(item => item.title === 'plain-restored-note');
  assert.ok(block);
  assert.ok(block.content.includes('No analysis is needed.'));
  try {
    await this.page.locator('.canvas-card', { hasText: 'plain-restored-note' }).waitFor();
  } catch (failure) {
    throw new Error(`${failure.message}\nReload URL: ${this.page.url()}\nPage errors: ${JSON.stringify(this.pageErrors)}\nVisible page: ${await this.page.locator('body').innerText()}`);
  }
  assert.deepEqual(this.actionRequests, []);
  assert.equal(await this.page.getByRole('dialog', { name: 'Review Jev upload suggestions' }).count(), 0);
  assert.deepEqual(this.pageErrors, []);
});
