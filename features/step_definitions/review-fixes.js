import { strict as assert } from 'node:assert';
import { When, Then } from '@cucumber/cucumber';

async function api(world, route, method = 'GET', body) {
  const response = await fetch(world.baseUrl + '/api' + route, { method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}

When('I open a saved document in the reader and then its file history', async function () {
  const canvas = await api(this, '/canvases/' + this.canvasId);
  this.readerDocument = canvas.blocks[0];
  await this.page.goto(`${this.baseUrl}/?canvas=${this.canvasId}&doc=${this.readerDocument.id}`, { waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'File history', exact: true }).click();
  await this.page.getByRole('dialog', { name: 'History and branches', exact: true }).waitFor();
  await this.page.locator('.version-panel__current', { hasText: 'Current saved branch: main' }).waitFor();
});

Then('Escape closes the file history and keeps the reader open', async function () {
  // Focus leaves the dialog first: Escape must still close the topmost surface, not whatever holds focus.
  await this.page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await this.page.keyboard.press('Escape');
  await this.page.getByRole('dialog', { name: 'History and branches', exact: true }).waitFor({ state: 'hidden' });
  await this.page.getByRole('dialog', { name: `${this.readerDocument.title} full page`, exact: true }).waitFor();
});

Then('a second Escape returns to the canvas without changing the document', async function () {
  await this.page.keyboard.press('Escape');
  await this.page.getByRole('dialog', { name: `${this.readerDocument.title} full page`, exact: true }).waitFor({ state: 'hidden' });
  await this.page.locator('.canvas-surface').waitFor();
  const saved = (await api(this, '/canvases/' + this.canvasId)).blocks.find(block => block.id === this.readerDocument.id);
  assert.equal(saved.content, this.readerDocument.content);
  assert.deepEqual(this.pageErrors, []);
});

When('I save three documents of one group far apart on a new canvas', async function () {
  const source = await api(this, '/canvases/' + this.canvasId);
  const canvas = await api(this, `/workspaces/${source.workspaceId}/canvases`, 'POST', { name: 'Scattered group' });
  const places = [{ x: 2200, y: 0 }, { x: 0, y: 1800 }, { x: 4200, y: 3600 }];
  const documents = [];
  for (const [index, place] of places.entries()) {
    const created = await api(this, `/canvases/${canvas.id}/blocks`, 'POST', { title: `Field note ${index + 1}`, content: `# Field note ${index + 1}`, ...place });
    documents.push(await api(this, `/canvases/${canvas.id}/blocks/${created.id}`, 'PUT', { ...place, group: 'custom:field_notes' }));
  }
  this.canvasId = canvas.id;
  this.scattered = { documents, before: documents.map(({ id, x, y }) => ({ id, x, y })) };
});

When('I open the scattered group', async function () {
  const breadcrumb = this.page.locator('.canvas-breadcrumb');
  for (let attempt = 0; attempt < 3 && !(await breadcrumb.textContent())?.includes('Field notes'); attempt++) {
    await this.page.locator('.canvas-group__heading button', { hasText: 'Field notes' }).first().click();
    await this.page.waitForTimeout(400);
  }
  await breadcrumb.filter({ hasText: 'Field notes' }).waitFor();
});

Then('every document in the group is visible in the canvas view', async function () {
  await this.page.waitForFunction(ids => {
    const stage = document.querySelector('.canvas-surface')?.getBoundingClientRect();
    return stage && ids.every(id => {
      const card = document.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect();
      return card && card.width > 0 && card.left >= stage.left && card.right <= stage.right && card.top >= stage.top && card.bottom <= stage.bottom;
    });
  }, this.scattered.documents.map(document => document.id), { timeout: 10_000 });
  assert.deepEqual(this.pageErrors, []);
});

Then('the saved document positions are unchanged after reload', async function () {
  await this.page.reload({ waitUntil: 'networkidle' });
  const canvas = await api(this, '/canvases/' + this.canvasId);
  assert.deepEqual(canvas.blocks.map(({ id, x, y }) => ({ id, x, y })), this.scattered.before);
});
