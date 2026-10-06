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

When('I assign the new document to nested group {string} with tag {string}', async function (group, tag) {
  const result = await request(this, `/api/canvases/${this.canvasId}/blocks/${this.block.id}`, 'PUT', { group, tags: [tag] });
  assert.equal(result.status, 200);
});

Then('reloading the canvas keeps the nested group and tag', async function () {
  const result = await request(this, `/api/canvases/${this.canvasId}`);
  const block = result.body.blocks.find(item => item.id === this.block.id);
  assert.equal(block.group, 'custom:research/benchmarks');
  assert.deepEqual(block.tags, ['api']);
});

Then('searching for {string} reports its canvas, group, and title match', async function (query) {
  const result = await request(this, `/api/search?q=${encodeURIComponent(query)}`);
  const hit = result.body.find(item => item.blockId === this.block.id);
  assert.equal(hit.canvasId, this.canvasId);
  assert.equal(hit.group, 'custom:research/benchmarks');
  assert.equal(hit.matchIn, 'title');
  assert.deepEqual(hit.tags, ['api']);
  assert.ok(hit.canvasName);
});

When('I search the canvas for {string}', async function (query) {
  await this.page.getByRole('button', { name: 'Search documents' }).click();
  await this.page.getByPlaceholder('Search every Markdown file…').fill(query);
  await this.page.getByRole('button', { name: `Show ${query} on canvas` }).waitFor();
});

Then('I see a match counter while the canvas stays visible', async function () {
  assert.equal(await this.page.locator('.canvas-surface').count(), 1);
  const search = this.page.getByRole('dialog', { name: 'Search documents' });
  const count = await search.locator('.canvas-search__result').count();
  assert.ok(count >= 1, 'Search must show the document on this canvas');
  assert.equal(await search.locator('.canvas-search__section').first().locator('.canvas-search__result').count(), 1);
  assert.equal(await search.locator('.canvas-search__count strong').innerText(), `1 of ${count}`);
  assert.equal(await search.locator('.canvas-search__count span').innerText(), `1 on this canvas · ${count - 1} elsewhere`);
  assert.deepEqual(this.pageErrors, []);
});

When('I show the {string} search result on the canvas', async function (title) {
  await this.page.getByRole('button', { name: `Show ${title} on canvas` }).click();
});

Then('the {string} card is highlighted and search stays open', async function (title) {
  await this.page.locator('.canvas-card.is-highlighted', { hasText: title }).waitFor();
  assert.equal(await this.page.getByRole('dialog', { name: 'Search documents' }).count(), 1);
  assert.equal(await this.page.getByRole('dialog', { name: 'Document editor' }).count(), 0);
  assert.deepEqual(this.pageErrors, []);
});

When('I zoom out to the group overview', async function () {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await this.page.locator('.canvas-surface--overview').count()) return;
    await this.page.locator('.react-flow__controls-zoomout').click();
  }
  await this.page.locator('.canvas-surface--overview').waitFor();
});

Then('I can see the group connection on the canvas and move the view', async function () {
  await this.page.waitForFunction(() => document.querySelectorAll('.react-flow__edge.canvas-group-edge').length > 0);
  const connection = this.page.locator('.react-flow__edge.canvas-group-edge').first();
  assert.match(await connection.getAttribute('data-testid') ?? '', /edge-group-edge:/);
  const viewport = this.page.locator('.react-flow__viewport');
  const start = await viewport.getAttribute('style');
  const surface = await this.page.locator('.canvas-flow-stage').boundingBox();
  assert.ok(surface);
  await this.page.mouse.move(surface.x + surface.width - 36, surface.y + surface.height / 2);
  await this.page.mouse.wheel(0, 350);
  await this.page.waitForFunction(previous => document.querySelector('.react-flow__viewport')?.getAttribute('style') !== previous, start);
  assert.deepEqual(this.pageErrors, []);
});

When('I open the mini-map group list', async function () {
  await this.page.getByRole('navigation', { name: 'Mini-map groups' }).locator('summary').click();
});

Then('the mini-map lists the Research group', async function () {
  await this.page.getByRole('navigation', { name: 'Mini-map groups' }).getByRole('button', { name: /^Research/ }).waitFor();
  assert.equal(await this.page.getByRole('button', { name: 'Show group list', exact: true }).count(), 0);
  assert.equal(await this.page.getByRole('navigation', { name: 'Group overview' }).count(), 0);
  assert.deepEqual(this.pageErrors, []);
});

When('I open the Research group', async function () {
  await this.page.getByRole('navigation', { name: 'Mini-map groups' }).getByRole('button', { name: /^Research/ }).click();
});

Then('the Notes subgroup appears on the canvas', async function () {
  await this.page.locator('.react-flow__node-groupFrame', { hasText: 'Notes' }).waitFor();
  assert.match(await this.page.locator('.canvas-zoom-label').innerText(), /Subgroups/);
  assert.deepEqual(this.pageErrors, []);
});

When('I open the Notes subgroup', async function () {
  await this.page.locator('.react-flow__node-groupFrame', { hasText: 'Notes' }).getByRole('button', { name: 'Notes' }).click();
});

Then('the canvas shows the real document preview', async function () {
  await this.page.locator('.canvas-card', { hasText: 'This note has real details' }).waitFor();
  assert.match(await this.page.locator('.canvas-zoom-label').innerText(), /Files/);
  assert.deepEqual(this.pageErrors, []);
});

When('I read the {string} nested document', async function (title) {
  await this.page.getByRole('button', { name: `Read ${title} full page` }).click();
  const reader = this.page.getByRole('dialog', { name: `${title} full page` });
  await reader.getByText('This note has real details', { exact: true }).waitFor();
});

Then('reloading keeps the nested document and its group', async function () {
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.locator('.canvas-surface').waitFor();
  const result = await request(this, `/api/canvases/${this.canvasId}`);
  const source = result.body.blocks.find(block => block.title === 'Real note');
  const target = result.body.blocks.find(block => block.title === 'Other note');
  assert.equal(source.content, 'This note has real details');
  assert.equal(source.group, 'custom:research/notes');
  assert.deepEqual(source.tags, ['example']);
  assert.deepEqual(source.links, [target.id]);
  assert.deepEqual(this.pageErrors, []);
});

When('I fill it with linked groups and nested research documents', async function () {
  const examples = [
    ['Research notes', 'custom:research/notes', 'Research notes content'],
    ['Research benchmarks', 'custom:research/benchmarks', 'Measured results'],
    ['Research sources', 'custom:research/sources', 'Source documents'],
    ...['frontend', 'backend', 'integrations', 'architecture', 'roadmap', 'security', 'operations', 'design']
      .map(group => [group, `custom:${group}`, `${group} content`]),
  ];
  const ids = [];
  for (const [index, [title, group, content]] of examples.entries()) {
    const created = await request(this, `/api/canvases/${this.canvasId}/blocks`, 'POST', { title, content, kind: 'markdown' });
    assert.equal(created.status, 201);
    ids.push(created.body.id);
    const updated = await request(this, `/api/canvases/${this.canvasId}/blocks/${created.body.id}`, 'PUT', {
      group, x: (index % 4) * 500, y: Math.floor(index / 4) * 360,
    });
    assert.equal(updated.status, 200);
  }
  const linked = await request(this, `/api/canvases/${this.canvasId}/blocks/${ids[0]}`, 'PUT', { links: [ids[1], ...ids.slice(3)] });
  assert.equal(linked.status, 200);
});

Then('I see supergroups connected on the canvas', async function () {
  await this.page.locator('.canvas-group.is-super').first().waitFor();
  assert.equal(await this.page.locator('.canvas-group.is-super').count(), 2);
  assert.ok(await this.page.locator('.react-flow__edge.canvas-group-edge').count() > 0);
  assert.deepEqual(this.pageErrors, []);
});

async function zoomIntoGroup(page, selector, expectedLevel) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await page.locator('.canvas-zoom-label').innerText()).includes(expectedLevel)) return;
    const card = page.locator(selector).first();
    const bounds = await card.boundingBox({ timeout: 3000 }).catch(async () => {
      await page.waitForTimeout(500);
      if ((await page.locator('.canvas-zoom-label').innerText()).includes(expectedLevel)) return null;
      const level = await page.locator('.canvas-zoom-label').innerText();
      const breadcrumb = await page.locator('.canvas-breadcrumb').innerText();
      const visible = await page.locator('.canvas-group.is-overview .canvas-group__heading button:first-of-type').allTextContents();
      throw new Error(`Zoom target vanished: ${selector}; level=${level}; breadcrumb=${breadcrumb}; visible=${visible.join(', ')}`);
    });
    if (!bounds) return;
    assert.ok(bounds, `Could not find ${selector} to zoom into`);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, -180);
    await page.waitForTimeout(300);
    if ((await page.locator('.canvas-zoom-label').innerText()).includes(expectedLevel)) return;
  }
  throw new Error(`Zoom did not open ${expectedLevel}`);
}

When('I zoom in over the Research supergroup', async function () {
  await zoomIntoGroup(this.page, '.canvas-group.is-super:has-text("Research")', 'Groups');
});

Then('I see its Research group on the canvas', async function () {
  await this.page.locator('.canvas-group.is-overview:not(.is-super)', { hasText: 'Research' }).first().waitFor();
  assert.match(await this.page.locator('.canvas-zoom-label').innerText(), /Groups/);
  assert.deepEqual(this.pageErrors, []);
});

When('I zoom in over the Research group', async function () {
  await zoomIntoGroup(this.page, '.canvas-group.is-overview:not(.is-super):has-text("Research")', 'Subgroups');
});

Then('I see connected Notes and Benchmarks subgroups', async function () {
  await this.page.locator('.canvas-group.is-overview .canvas-group__heading button', { hasText: 'Notes' }).waitFor();
  await this.page.locator('.canvas-group.is-overview .canvas-group__heading button', { hasText: 'Benchmarks' }).waitFor();
  const connection = this.page.locator('[data-testid*="group-edge:custom:research/notes->custom:research/benchmarks"]');
  await connection.waitFor({ state: 'attached' });
  const path = await connection.locator('.react-flow__edge-path').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, opacity: getComputedStyle(element).opacity, visibility: getComputedStyle(element).visibility };
  });
  assert.ok(path.width > 0 || path.height > 0, `Group connection has no visible geometry: ${JSON.stringify(path)}`);
  assert.match(await this.page.locator('.canvas-zoom-label').innerText(), /Subgroups/);
  assert.deepEqual(this.pageErrors, []);
});

When('I zoom in over the Notes subgroup', async function () {
  await zoomIntoGroup(this.page, '.canvas-group.is-overview:has-text("Notes")', 'Files');
});

When('I zoom out to the subgroup map', async function () {
  const bounds = await this.page.locator('.canvas-flow-stage').boundingBox();
  assert.ok(bounds);
  await this.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 70);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await this.page.mouse.wheel(0, 180);
    await this.page.waitForTimeout(300);
    if ((await this.page.locator('.canvas-zoom-label').innerText()).includes('Subgroups')) return;
  }
  throw new Error('Zoom did not return to subgroups');
});

Then('the canvas shows the research document card', async function () {
  await this.page.locator('.canvas-card', { hasText: 'Research notes content' }).waitFor();
  assert.equal(await this.page.locator('.canvas-drill-board').count(), 0);
  assert.match(await this.page.locator('.canvas-zoom-label').innerText(), /Files/);
  assert.deepEqual(this.pageErrors, []);
});

When('I select the {string} card', async function (title) {
  await this.page.locator('.canvas-card', { hasText: title }).first().click();
});

Then('I see connection focus and its linked document', async function () {
  assert.equal(await this.page.getByRole('button', { name: '+1 hop' }).count(), 1);
  assert.equal(await this.page.getByRole('button', { name: '+2 hops' }).count(), 1);
  const inspector = this.page.getByRole('complementary', { name: 'Selection inspector' });
  assert.equal(await inspector.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected'), 'true');
  await inspector.getByRole('tab', { name: 'Details' }).click();
  assert.equal(await inspector.getByRole('button', { name: 'Target' }).count(), 1);
  assert.deepEqual(this.pageErrors, []);
});

When('I pull linked documents close and restore their positions', async function () {
  const result = await request(this, `/api/canvases/${this.canvasId}`);
  this.originalPositions = result.body.blocks.map(block => ({ id: block.id, x: block.x, y: block.y }));
  assert.equal(await this.page.getByRole('button', { name: 'Arrange by connections' }).count(), 0);
  await this.page.getByRole('button', { name: 'Pull neighbors close' }).click();
  await this.page.getByRole('button', { name: 'Restore positions' }).click();
});

Then('reloading the canvas keeps the original positions', async function () {
  const result = await request(this, `/api/canvases/${this.canvasId}`);
  assert.deepEqual(result.body.blocks.map(block => ({ id: block.id, x: block.x, y: block.y })), this.originalPositions);
});

Then('manual grouping controls are absent', async function () {
  for (const name of ['Group documents', 'Show preview on canvas', 'Accept grouping', 'Undo grouping']) {
    assert.equal(await this.page.getByRole('button', { name, exact: true }).count(), 0);
  }
  assert.equal(await this.page.getByRole('complementary', { name: 'Suggested groups' }).count(), 0);
  assert.equal(await this.page.getByRole('tab', { name: 'By tags' }).count(), 0);
  assert.equal(await this.page.getByRole('button', { name: 'Browse groups', exact: true }).count(), 1);
  assert.deepEqual(this.pageErrors, []);
});

When('I reload the current canvas in the browser', async function () {
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.locator('.canvas-surface').waitFor();
});

When('I create a second canvas called {string}', async function (name) {
  const workspaces = await request(this, '/api/workspaces');
  const created = await request(this, `/api/workspaces/${workspaces.body[0].id}/canvases`, 'POST', { name });
  assert.equal(created.status, 201);
  this.secondCanvasId = created.body.id;
  this.navigationCanvasBefore = (await request(this, `/api/canvases/${this.canvasId}`)).body;
});

When('I navigate to {string} and back using the sidebar', async function (name) {
  await this.page.getByRole('button', { name: `Open canvas: ${name}`, exact: true }).click();
  await this.page.locator('.canvas-label').getByRole('heading', { name }).waitFor();
  const originalName = this.navigationCanvasBefore.name;
  await this.page.getByRole('button', { name: `Open canvas: ${originalName}`, exact: true }).click();
  await this.page.locator('.canvas-label').getByRole('heading', { name: originalName }).waitFor();
});

Then('the canvas reloads without the floating navigation bar', async function () {
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.locator('.canvas-label').getByRole('heading', { name: this.navigationCanvasBefore.name }).waitFor();
  assert.equal(await this.page.locator('.canvas-navigation').count(), 0);
  for (const name of ['Back to previous canvas view', 'Forward to next canvas view', 'Bookmarks and recently viewed', 'Hide header', 'Show header']) {
    assert.equal(await this.page.getByRole('button', { name, exact: true }).count(), 0);
  }
  assert.deepEqual((await request(this, `/api/canvases/${this.canvasId}`)).body, this.navigationCanvasBefore);
  assert.equal((await request(this, `/api/canvases/${this.secondCanvasId}`)).body.name, 'Second canvas');
  assert.equal(await this.page.getByRole('button', { name: 'Search documents', exact: true }).count(), 1);
  assert.deepEqual(this.pageErrors, []);
});
