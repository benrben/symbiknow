import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { After, Before, Given, Then, When, setDefaultTimeout } from '@cucumber/cucumber';
import { chromium } from 'playwright';

const run = promisify(execFile);
let browserBuild;
async function ensureBrowserBuild() {
  browserBuild ??= run('npm', ['run', 'build'], { cwd: process.cwd(), timeout: 60_000 })
    .catch(error => { browserBuild = undefined; throw error; });
  await browserBuild;
}
setDefaultTimeout(60_000);

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function request(world, path, method = 'GET', body) {
  const response = await fetch(`${world.baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function findMarkdownFile(directory, expected) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findMarkdownFile(path, expected);
      if (nested) return nested;
    } else if (entry.name.endsWith('.md') && (await readFile(path, 'utf8')).includes(expected)) {
      return path;
    }
  }
  return null;
}

Before(async function () {
  this.dataDir = await mkdtemp(join(tmpdir(), 'symbiknow-acceptance-'));
  this.port = await freePort();
  this.baseUrl = `http://127.0.0.1:${this.port}`;
  this.server = spawn(process.execPath, ['--import', 'tsx', 'features/acceptance-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: this.dataDir, PORT: String(this.port) },
    stdio: 'pipe',
  });
  this.serverOutput = '';
  this.server.stdout.on('data', (chunk) => { this.serverOutput += chunk; });
  this.server.stderr.on('data', (chunk) => { this.serverOutput += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${this.baseUrl}/api/workspaces`);
      if (response.ok) return;
    } catch { /* The server has not started yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${this.serverOutput}`);
});

After(async function () {
  await this.browser?.close();
  if (this.server && this.server.exitCode === null) {
    const stopped = new Promise(resolve => this.server.once('exit', resolve));
    this.server.kill();
    await stopped;
  }
  if (this.dataDir) await rm(this.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

Given('a fresh workspace', async function () {
  const { body: workspaces } = await request(this, '/api/workspaces');
  assert.ok(workspaces.length > 0);
  this.canvasId = workspaces[0].canvases[0].id;
});

When('I create an empty canvas for group automations', async function () {
  const { body: workspaces } = await request(this, '/api/workspaces');
  const result = await request(this, `/api/workspaces/${workspaces[0].id}/canvases`, 'POST', { name: 'Group automations' });
  assert.equal(result.status, 201);
  this.canvasId = result.body.id;
});

When('I open SymbiKnow in a browser', async function () {
  await ensureBrowserBuild();
  this.browser = await chromium.launch({ headless: true });
  this.page = await this.browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.goto(this.baseUrl, { waitUntil: 'networkidle' });
  await this.page.locator('.canvas-surface').waitFor();
  this.lightCanvasColor = await this.page.locator('.canvas-surface').evaluate(element => getComputedStyle(element).backgroundColor);
});

When('I open the current canvas in a browser', async function () {
  await ensureBrowserBuild();
  this.browser = await chromium.launch({ headless: true });
  this.page = await this.browser.newPage({ viewport: { width: 1440, height: 900 } });
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.goto(`${this.baseUrl}/?canvas=${this.canvasId}`, { waitUntil: 'networkidle' });
  await this.page.locator('.canvas-surface').waitFor();
});

When('I save a new block titled {string}', async function (title) {
  await this.page.getByRole('button', { name: /Add (your first )?block/ }).first().click();
  const editor = this.page.getByRole('dialog', { name: 'Block editor' });
  await editor.getByLabel('Title').fill(title);
  await editor.getByRole('button', { name: 'Save block' }).click();
  await editor.waitFor({ state: 'hidden' });
  await this.page.locator('.canvas-card__identity strong', { hasText: title }).waitFor();
});

Then('the new card is highlighted and the cards do not overlap', async function () {
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  const cards = canvas.blocks.map(block => ({ left: block.x, right: block.x + block.width,
    top: block.y, bottom: block.y + block.height }));
  assert.equal(cards.length, 2);
  assert.ok(cards[0].right <= cards[1].left || cards[1].right <= cards[0].left ||
    cards[0].bottom <= cards[1].top || cards[1].bottom <= cards[0].top);
  assert.equal(await this.page.locator('.canvas-card.is-highlighted').count(), 1);
  assert.deepEqual(this.pageErrors, []);
});

When('I search for {string} and choose Show on canvas', async function (title) {
  await this.page.getByRole('button', { name: 'Search documents' }).click();
  await this.page.getByPlaceholder('Search every Markdown file…').fill(title);
  await this.page.getByRole('button', { name: `Show ${title} on canvas` }).click();
});

Then('the searched card is highlighted without opening its editor', async function () {
  await this.page.locator('.canvas-card.is-highlighted', { hasText: 'First note' }).waitFor();
  assert.equal(await this.page.getByRole('dialog', { name: 'Block editor' }).count(), 0);
  assert.deepEqual(this.pageErrors, []);
});

Then('the app identifies an infinite canvas for people and AI', async function () {
  assert.equal(await this.page.title(), 'SymbiKnow — Make knowledge together');
  assert.equal(await this.page.locator('.brand').getByText('symbiknow', { exact: true }).count(), 1);
  assert.equal(await this.page.locator('.canvas-label').getByText('PEOPLE + AI · INFINITE CANVAS').count(), 1);
  assert.equal(await this.page.locator('.canvas-surface').count(), 1);
  assert.deepEqual(this.pageErrors, []);
});

When('I switch to dark mode', async function () {
  await this.page.getByRole('button', { name: 'Switch to dark mode' }).click();
});

Then('the dark canvas remains selected after reloading', async function () {
  const darkColor = await this.page.locator('.canvas-surface').evaluate(element => getComputedStyle(element).backgroundColor);
  assert.notEqual(darkColor, this.lightCanvasColor);
  assert.equal(await this.page.locator('html').getAttribute('data-theme'), 'dark');
  await this.page.reload({ waitUntil: 'networkidle' });
  assert.equal(await this.page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await this.page.locator('.canvas-surface').evaluate(element => getComputedStyle(element).backgroundColor), darkColor);
  assert.deepEqual(this.pageErrors, []);
});

When('I switch to light mode', async function () {
  await this.page.getByRole('button', { name: 'Switch to light mode' }).click();
});

Then('the light canvas is selected', async function () {
  assert.equal(await this.page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await this.page.locator('.canvas-surface').evaluate(element => getComputedStyle(element).backgroundColor), this.lightCanvasColor);
  assert.deepEqual(this.pageErrors, []);
});

When('I add a Markdown block called {string} containing {string}', async function (title, content) {
  const result = await request(this, `/api/canvases/${this.canvasId}/blocks`, 'POST', { title, content, kind: 'markdown' });
  assert.equal(result.status, 201);
  this.block = result.body;
});

When('I load the canvas and remember its revision', async function () {
  const response = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}`);
  assert.equal(response.status, 200);
  this.canvasRevision = response.headers.get('etag');
  assert.ok(this.canvasRevision);
  await response.arrayBuffer();
});

Then('loading the unchanged canvas sends no body', async function () {
  const response = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}`, {
    headers: { 'if-none-match': this.canvasRevision },
  });
  assert.equal(response.status, 304);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
});

When('I edit the Markdown file outside the app from {string} to {string}', async function (before, after) {
  const file = join(this.dataDir, this.block.file);
  const current = await readFile(file, 'utf8');
  assert.ok(current.includes(before));
  await writeFile(file, current.replace(before, after));
});

Then('loading with the old revision returns the updated document', async function () {
  const response = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}`, {
    headers: { 'if-none-match': this.canvasRevision },
  });
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get('etag'), this.canvasRevision);
  const canvas = await response.json();
  assert.equal(canvas.blocks.find(block => block.id === this.block.id)?.content, 'After');
});

When('I create a Markdown block called {string} at x {int} and y {int}', async function (title, x, y) {
  const result = await request(this, `/api/canvases/${this.canvasId}/blocks`, 'POST', { title, content: `# ${title}`, x, y });
  assert.equal(result.status, 201);
});

Then('reloading the canvas shows three cards without overlap', async function () {
  const result = await request(this, `/api/canvases/${this.canvasId}`);
  assert.equal(result.status, 200);
  const blocks = result.body.blocks;
  assert.equal(blocks.length, 3);
  for (const [index, block] of blocks.entries()) {
    for (const other of blocks.slice(index + 1)) {
      assert.ok(block.x + block.width <= other.x || other.x + other.width <= block.x ||
        block.y + block.height <= other.y || other.y + other.height <= block.y);
    }
  }
});

When('I delete the new document', async function () {
  const result = await request(this, `/api/canvases/${this.canvasId}/blocks/${this.block.id}`, 'DELETE');
  assert.equal(result.status, 200);
});

When('I delete the current canvas in the browser', async function () {
  await this.page.getByRole('button', { name: 'Delete canvas: Group automations' }).click();
  const dialog = this.page.getByRole('dialog', { name: 'Delete canvas' });
  await dialog.getByText('This cannot be undone.', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Delete canvas' }).click();
  await this.page.getByRole('region', { name: 'Product Roadmap infinite canvas' }).waitFor();
});

Then('the deleted canvas is gone after reloading', async function () {
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.getByRole('region', { name: 'Product Roadmap infinite canvas' }).waitFor();
  assert.equal((await request(this, `/api/canvases/${this.canvasId}`)).status, 404);
  await assert.rejects(readFile(join(this.dataDir, this.block.file), 'utf8'), { code: 'ENOENT' });
  assert.deepEqual(this.pageErrors, []);
});

Then('reloading the canvas does not restore the deleted document', async function () {
  const result = await request(this, `/api/canvases/${this.canvasId}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.blocks.some((block) => block.id === this.block.id), false);
});

Then('the deleted Markdown file is gone', async function () {
  await assert.rejects(readFile(join(this.dataDir, this.block.file), 'utf8'), { code: 'ENOENT' });
});

Then('the canvas contains the {string} block', async function (title) {
  const result = await request(this, `/api/canvases/${this.canvasId}`);
  assert.equal(result.status, 200);
  assert.ok(result.body.blocks.some((block) => block.title === title));
});

Then('the block is backed by a Markdown file containing {string}', async function (content) {
  assert.match(this.block.file, /\.md$/);
  assert.ok(await findMarkdownFile(this.dataDir, content));
});

Then('searching for {string} finds the block', async function (query) {
  const result = await request(this, `/api/search?q=${encodeURIComponent(query)}`);
  assert.equal(result.status, 200);
  assert.ok(result.body.some((item) => item.blockId === this.block.id));
});

When('I configure the OpenRouter model {string} and an API key', async function (model) {
  this.key = 'acceptance-key-placeholder';
  const result = await request(this, '/api/settings', 'PUT', { model, apiKey: this.key });
  assert.equal(result.status, 200);
});

Then('the settings report that an API key is saved', async function () {
  const result = await request(this, '/api/settings');
  assert.equal(result.status, 200);
  assert.equal(result.body.hasApiKey, true);
});

Then('the settings response does not reveal the API key', async function () {
  const result = await request(this, '/api/settings');
  assert.equal(JSON.stringify(result.body).includes(this.key), false);
  assert.equal(Object.hasOwn(result.body, 'apiKey'), false);
});

When('I send a chat message without an API key', async function () {
  this.chatResponse = await request(this, '/api/chat', 'POST', {
    canvasId: this.canvasId,
    messages: [{ role: 'user', content: 'Summarize the canvas' }],
  });
});

When('I send a streaming chat message without an API key', async function () {
  this.chatResponse = await request(this, '/api/chat/stream', 'POST', {
    canvasId: this.canvasId,
    messages: [{ role: 'user', content: 'Summarize the canvas' }],
  });
});

Then('the chat request is rejected with a settings error', function () {
  assert.ok(this.chatResponse.status >= 400 && this.chatResponse.status < 500);
  assert.match(this.chatResponse.body.error, /key|settings|config/i);
});

When('I request canvas insights without an API key', async function () {
  this.insightsResponse = await request(this, `/api/canvases/${this.canvasId}/insights`, 'POST', { query: 'launch' });
});

Then('the insights request is rejected with a settings error', function () {
  assert.equal(this.insightsResponse.status, 400);
  assert.match(this.insightsResponse.body.error, /TypeSafe|key|settings/i);
});

async function canvasBlock(world, title) {
  const result = await request(world, `/api/canvases/${world.canvasId}`);
  assert.equal(result.status, 200);
  const block = result.body.blocks.find((item) => item.title === title);
  assert.ok(block, `Missing block: ${title}`);
  return block;
}

When('I arrange the {string} block at x {int} and y {int}', async function (title, x, y) {
  const block = await canvasBlock(this, title);
  const result = await request(this, `/api/canvases/${this.canvasId}/layout`, 'PUT', { positions: [{ blockId: block.id, x, y }] });
  assert.equal(result.status, 200);
});

Then('reloading the canvas keeps {string} at x {int} and y {int}', async function (title, x, y) {
  const block = await canvasBlock(this, title);
  assert.equal(block.x, x);
  assert.equal(block.y, y);
});

When('I label {string} as {string} for {string}', async function (title, purpose, reviewer) {
  const block = await canvasBlock(this, title);
  const result = await request(this, `/api/canvases/${this.canvasId}/blocks/${block.id}`, 'PUT', { purpose, reviewer });
  assert.equal(result.status, 200);
});

Then('reloading the canvas shows {string} as {string} for {string}', async function (title, purpose, reviewer) {
  const block = await canvasBlock(this, title);
  assert.equal(block.purpose, purpose);
  assert.equal(block.reviewer, reviewer);
});

When('I connect {string} to {string}', async function (fromTitle, toTitle) {
  const from = await canvasBlock(this, fromTitle);
  const to = await canvasBlock(this, toTitle);
  const result = await request(this, `/api/canvases/${this.canvasId}/blocks/${from.id}`, 'PUT', { links: [...from.links, to.id] });
  assert.equal(result.status, 200);
  this.connection = { fromTitle, toId: to.id };
});

Then('reloading the canvas keeps that connection', async function () {
  const from = await canvasBlock(this, this.connection.fromTitle);
  assert.ok(from.links.includes(this.connection.toId));
});

When('I open Insights with a moderate-confidence Jev connection from {string} to {string}', async function (fromTitle, toTitle) {
  const from = await canvasBlock(this, fromTitle);
  const to = await canvasBlock(this, toTitle);
  const settings = await request(this, '/api/settings', 'PUT', { model: 'openai/gpt-4o-mini', jevApiKey: 'acceptance-placeholder' });
  assert.equal(settings.status, 200);
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  const report = { canvasId: this.canvasId, query: '', analyzed: canvas.blocks.length, total: canvas.blocks.length,
    readingOrder: [], relevance: [], items: [{ id: 'jev-link', category: 'connection', title: 'Connect these documents',
      detail: 'Jev rated this as a useful reading connection.', blockIds: [from.id, to.id], confidence: 0.77 }] };
  await ensureBrowserBuild();
  this.browser = await chromium.launch({ headless: true });
  this.page = await this.browser.newPage();
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.route(`**/api/canvases/${this.canvasId}/insights`, route => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify(report) }));
  await this.page.goto(this.baseUrl, { waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Insights' }).click();
  this.connection = { fromTitle, toId: to.id };
});

When('I press the Connect documents automation', async function () {
  await this.page.getByRole('button', { name: 'Connect documents' }).click();
  await this.page.getByRole('status').filter({ hasText: 'Applied 1 connection change' }).waitFor();
  assert.deepEqual(this.pageErrors, []);
});

When('I open Insights with two Jev groups and three suggested connections', async function () {
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  const byTitle = Object.fromEntries(canvas.blocks.map((block) => [block.title, block]));
  const names = ['Group A1', 'Group A2', 'Group B1', 'Group B2'];
  this.groupDocs = names.map((name) => byTitle[name]);
  assert.ok(this.groupDocs.every(Boolean));
  this.initialEdgeCount = canvas.blocks.reduce((count, block) => count + block.links.length, 0);
  const pairs = [[0, 1], [0, 2], [2, 3]];
  const report = { canvasId: this.canvasId, query: '', analyzed: canvas.blocks.length, total: canvas.blocks.length,
    readingOrder: canvas.blocks.map((block, index) => ({ blockId: block.id, title: block.title,
      score: index / canvas.blocks.length, confidence: 0.9,
      lane: block.title.startsWith('Group A') ? 'overview' : 'work' })), relevance: [],
    classification: canvas.blocks.map(block => ({ blockId: block.id, title: block.title,
      lane: block.title.startsWith('Group B') ? 'work' : 'overview', laneConfidence: 0.9 })), groupBy: 'lane',
    items: pairs.map(([from, to], index) => ({ id: `link-${index}`, category: 'connection', title: 'Connect documents',
      detail: 'Jev selected this link.', blockIds: [this.groupDocs[from].id, this.groupDocs[to].id], confidence: 0.75 })) };
  const settings = await request(this, '/api/settings', 'PUT', { model: 'openai/gpt-4o-mini', jevApiKey: 'acceptance-placeholder', groupBy: 'lane' });
  assert.equal(settings.status, 200);
  await ensureBrowserBuild();
  this.browser = await chromium.launch({ headless: true });
  this.page = await this.browser.newPage();
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.route(`**/api/canvases/${this.canvasId}/insights`, route => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify(report) }));
  await this.page.goto(this.baseUrl, { waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Group automations', exact: true }).click();
  await this.page.getByRole('button', { name: 'Insights' }).click();
});

When('I press the Organize positions automation', async function () {
  await this.page.getByRole('button', { name: 'Organize positions' }).click();
  await this.page.getByRole('status').filter({ hasText: 'Applied 1 layout update' }).waitFor();
  assert.deepEqual(this.pageErrors, []);
});

When('I analyze the canvas and see two document groups', async function () {
  await this.page.getByRole('button', { name: 'Analyze canvas' }).click();
  const dashboard = this.page.getByRole('region', { name: 'Document groups' });
  await dashboard.waitFor();
  await dashboard.getByText('Overview', { exact: true }).waitFor();
  await dashboard.getByText('Active work', { exact: true }).waitFor();
  assert.deepEqual(this.pageErrors, []);
});

When('I press the Connect documents automation for three links', async function () {
  await this.page.getByRole('button', { name: 'Connect documents' }).click();
  await this.page.getByRole('status').filter({ hasText: 'Applied 3 connection changes' }).waitFor();
  assert.deepEqual(this.pageErrors, []);
});

When('I press the Regroup and connect automation', async function () {
  await this.page.getByRole('button', { name: 'Regroup & connect' }).click();
  await this.page.getByRole('status').filter({ hasText: 'and updated links' }).waitFor();
  assert.deepEqual(this.pageErrors, []);
});

Then('reloading the canvas shows two groups and three new edges', async function () {
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  const updated = this.groupDocs.map((original) => canvas.blocks.find((block) => block.id === original.id));
  assert.equal(updated[0].x, updated[1].x);
  assert.equal(updated[2].x, updated[3].x);
  assert.deepEqual(updated.map(block => block.group), ['lane:overview', 'lane:overview', 'lane:work', 'lane:work']);
  assert.ok(Math.abs(updated[0].x - updated[2].x) >= updated[0].width + 150);
  const edgeCount = canvas.blocks.reduce((count, block) => count + block.links.length, 0);
  assert.equal(edgeCount - this.initialEdgeCount, 3);
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Group automations', exact: true }).click();
  await this.page.getByLabel(/Overview group, \d+ documents/).waitFor();
  await this.page.getByLabel(/Active work group, \d+ documents/).waitFor();
  assert.deepEqual(this.pageErrors, []);
});

When('I open Insights with Jev rejecting that connection', async function () {
  const from = await canvasBlock(this, this.connection.fromTitle);
  const report = { canvasId: this.canvasId, query: '', analyzed: 5, total: 5, readingOrder: [], relevance: [],
    items: [{ id: 'unlink-saved-edge', category: 'connection', title: 'Remove this link',
      detail: 'Jev found the saved edge unhelpful.', blockIds: [from.id, this.connection.toId], confidence: 0.95,
      action: { type: 'unlink', fromBlockId: from.id, toBlockId: this.connection.toId } }] };
  const settings = await request(this, '/api/settings', 'PUT', { model: 'openai/gpt-4o-mini', jevApiKey: 'acceptance-placeholder' });
  assert.equal(settings.status, 200);
  await ensureBrowserBuild();
  this.browser = await chromium.launch({ headless: true });
  this.page = await this.browser.newPage();
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.route(`**/api/canvases/${this.canvasId}/insights`, route => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify(report) }));
  await this.page.goto(this.baseUrl, { waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Insights' }).click();
});

Then('reloading the canvas no longer has that connection', async function () {
  const from = await canvasBlock(this, this.connection.fromTitle);
  assert.equal(from.links.includes(this.connection.toId), false);
});

When('I send a chat message then press New chat', async function () {
  await ensureBrowserBuild();
  this.browser = await chromium.launch({ headless: true });
  this.page = await this.browser.newPage();
  this.chatRequests = [];
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.route('**/api/chat/stream', async (route) => {
    this.chatRequests.push(route.request().postDataJSON());
    const reply = this.chatRequests.length === 1 ? 'First answer.' : 'Second answer.';
    await route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n` });
  });
  await this.page.goto(this.baseUrl, { waitUntil: 'networkidle' });
  await this.page.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }).fill('First question');
  await this.page.getByRole('button', { name: 'Submit' }).click();
  await this.page.getByText('First answer.').waitFor();
  await this.page.getByRole('button', { name: 'New chat' }).click();
  await this.page.getByRole('heading', { name: 'Build knowledge together' }).waitFor();
  assert.equal(await this.page.getByText('First answer.').count(), 0);
  assert.deepEqual(this.pageErrors, []);
});

Then('the next chat request contains only the new message', async function () {
  await this.page.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }).fill('Second question');
  await this.page.getByRole('button', { name: 'Submit' }).click();
  await this.page.getByText('Second answer.').waitFor();
  assert.equal(this.chatRequests.length, 2);
  assert.deepEqual(this.chatRequests[1].messages, [{ role: 'user', content: 'Second question' }]);
  assert.deepEqual(this.pageErrors, []);
});

When('I drag the chat divider wider', async function () {
  await ensureBrowserBuild();
  this.browser = await chromium.launch({ headless: true });
  this.page = await this.browser.newPage({ viewport: { width: 1440, height: 900 } });
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.goto(this.baseUrl, { waitUntil: 'networkidle' });
  const panel = this.page.getByRole('complementary', { name: 'SymbiKnow assistant' });
  const handle = this.page.getByRole('separator', { name: 'Resize chat panel' });
  const before = await panel.boundingBox();
  const grip = await handle.boundingBox();
  assert.ok(before && grip);
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await this.page.mouse.move(x, y);
  await this.page.mouse.down();
  await this.page.mouse.move(x - 90, y, { steps: 5 });
  await this.page.mouse.up();
  this.resizedWidth = (await panel.boundingBox()).width;
  assert.ok(this.resizedWidth >= before.width + 75);
});

Then('the chat panel keeps its new width after reloading', async function () {
  await this.page.reload({ waitUntil: 'networkidle' });
  const panel = this.page.getByRole('complementary', { name: 'SymbiKnow assistant' });
  const reloadedWidth = (await panel.boundingBox()).width;
  assert.ok(Math.abs(reloadedWidth - this.resizedWidth) < 2);
  assert.deepEqual(this.pageErrors, []);
});

When('I upload an HTML page', async function () {
  await ensureBrowserBuild();
  this.browser = await chromium.launch({ headless: true });
  this.page = await this.browser.newPage({ viewport: { width: 1440, height: 900 } });
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.goto(this.baseUrl, { waitUntil: 'networkidle' });
  await this.page.locator('input[type=file]').first().setInputFiles({
    name: 'Landing.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><html><body><h1>Landing page</h1></body></html>'),
  });
  await this.page.getByTitle('Landing HTML preview').first().waitFor();
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  this.htmlBlock = canvas.blocks.find(block => block.title === 'Landing');
  assert.ok(this.htmlBlock);
});

Then('the canvas shows its HTML preview inside a Markdown block', async function () {
  assert.equal(this.htmlBlock.kind, 'markdown');
  assert.match(this.htmlBlock.file, /\.md$/);
  assert.ok(this.htmlBlock.content.startsWith('---\nformat: html\n---\n'));
  const preview = this.page.getByTitle('Landing HTML preview').first();
  const sandbox = (await preview.getAttribute('sandbox'))?.split(/\s+/) || [];
  assert.ok(sandbox.includes('allow-scripts'));
  assert.ok(sandbox.includes('allow-forms'));
  assert.ok(sandbox.includes('allow-popups'));
  assert.ok(!sandbox.includes('allow-same-origin'));
  assert.ok((await preview.getAttribute('srcdoc')).includes('Landing page'));
});

Then('I can read the whole page and return to the canvas', async function () {
  await this.page.getByRole('button', { name: 'Read Landing full page' }).click();
  const reader = this.page.getByRole('dialog', { name: 'Landing full page' });
  await reader.getByRole('heading', { name: 'Landing' }).waitFor();
  assert.ok((await reader.getByTitle('Landing HTML preview').getAttribute('srcdoc')).includes('Landing page'));
  await reader.getByRole('button', { name: '← Back to canvas' }).click();
  assert.equal(await reader.count(), 0);
  await this.page.getByTitle('Landing HTML preview').first().waitFor();
});

Then('I can switch between source and a live HTML preview in the editor', async function () {
  await this.page.getByRole('button', { name: 'Edit Landing' }).click();
  const editor = this.page.getByRole('dialog', { name: 'Block editor' });
  const unsaved = '---\nformat: html\n---\n<!doctype html><html><body><h1>Unsaved preview</h1></body></html>';
  await editor.getByLabel('Markdown source').fill(unsaved);
  await editor.getByRole('button', { name: 'Preview' }).click();
  const preview = editor.getByTitle('Landing HTML preview');
  assert.ok((await preview.getAttribute('srcdoc')).includes('Unsaved preview'));
  await editor.getByRole('button', { name: 'Source' }).click();
  assert.equal(await editor.getByLabel('Markdown source').evaluate(element =>
    [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')), unsaved);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  assert.deepEqual(this.pageErrors, []);
});

Then('I can download its Markdown file and upload an edited version', async function () {
  const downloaded = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}/blocks/${this.htmlBlock.id}/download`);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  assert.equal(await downloaded.text(), this.htmlBlock.content);
  await this.page.getByRole('button', { name: 'Edit Landing' }).click();
  const editor = this.page.getByRole('dialog', { name: 'Block editor' });
  await editor.locator('input[type=file]').setInputFiles({ name: 'Landing.md', mimeType: 'text/markdown',
    buffer: Buffer.from('# Revised from disk\n') });
  await editor.getByLabel('Markdown source').getByText('# Revised from disk').waitFor();
  await editor.getByRole('button', { name: 'Save block' }).click();
  await editor.waitFor({ state: 'hidden' });
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  assert.equal(canvas.blocks.find(block => block.id === this.htmlBlock.id).content, '# Revised from disk\n');
  assert.deepEqual(this.pageErrors, []);
});

async function configureJev(world, withChat = false) {
  const result = await request(world, '/api/settings', 'PUT', {
    model: 'openai/gpt-4o-mini', jevApiKey: 'acceptance-placeholder',
    ...(withChat ? { apiKey: 'acceptance-chat-key' } : {}),
  });
  assert.equal(result.status, 200);
}

async function questionLog(world) {
  try {
    return (await readFile(join(world.dataDir, 'jev-questions.jsonl'), 'utf8')).trim().split('\n')
      .filter(Boolean).flatMap(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function emptyWorkspace(world, names) {
  const created = await request(world, '/api/workspaces', 'POST', { name: 'Acceptance workspace' });
  assert.equal(created.status, 201);
  world.workspaceId = created.body.id;
  world.canvasIds = [];
  for (const name of names) {
    const canvas = await request(world, `/api/workspaces/${world.workspaceId}/canvases`, 'POST', { name });
    assert.equal(canvas.status, 201);
    world.canvasIds.push(canvas.body.id);
  }
  world.canvasId = world.canvasIds[0];
}

When('I add a Marp Markdown deck called {string}', async function (title) {
  const result = await request(this, `/api/canvases/${this.canvasId}/blocks`, 'POST', {
    title, kind: 'markdown', content: '---\nmarp: true\n---\n# One\n---\n# Two',
  });
  assert.equal(result.status, 201);
});

When('I open Insights with a 0.5-confidence Jev connection from {string} to {string}', async function (fromTitle, toTitle) {
  const from = await canvasBlock(this, fromTitle);
  const to = await canvasBlock(this, toTitle);
  await configureJev(this);
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  const report = { canvasId: this.canvasId, query: '', analyzed: canvas.blocks.length, total: canvas.blocks.length,
    readingOrder: [], relevance: [], items: [{ id: 'low-jev-link', category: 'connection', title: 'Review this connection',
      detail: 'Jev gave this link a 0.5 confidence score.', blockIds: [from.id, to.id], confidence: 0.5 }] };
  await ensureBrowserBuild();
  this.browser = await chromium.launch({ headless: true });
  this.page = await this.browser.newPage();
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.route(`**/api/canvases/${this.canvasId}/insights`, route => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify(report) }));
  await this.page.goto(`${this.baseUrl}/?canvas=${this.canvasId}`, { waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Insights' }).click();
});

When('I press the Connect documents automation with no eligible link', async function () {
  await this.page.getByRole('button', { name: 'Connect documents' }).click();
  await this.page.getByRole('status').filter({ hasText: 'No eligible connection changes' }).waitFor();
  assert.deepEqual(this.pageErrors, []);
});

Then('reloading the canvas has no link from {string} to {string}', async function (fromTitle, toTitle) {
  const from = await canvasBlock(this, fromTitle);
  const to = await canvasBlock(this, toTitle);
  assert.equal(from.links.includes(to.id), false);
  await this.page.reload({ waitUntil: 'networkidle' });
  assert.deepEqual(this.pageErrors, []);
});

When('I request canvas insights', async function () {
  await configureJev(this);
  this.questionsBefore = await questionLog(this);
  this.insightsResponse = await request(this, `/api/canvases/${this.canvasId}/insights`, 'POST', { query: '' });
  assert.equal(this.insightsResponse.status, 200, JSON.stringify(this.insightsResponse.body));
  this.questionsAfter = await questionLog(this);
});

Then('the report suggests the slides loader for {string}', async function (title) {
  const block = await canvasBlock(this, title);
  assert.ok(this.insightsResponse.body.items.some(item => item.category === 'loader'
    && item.blockIds.includes(block.id) && item.action?.patch?.kind === 'slides'));
});

Then('Jev received no loader question', async function () {
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  const deckIndex = canvas.blocks.findIndex(block => block.title === 'Deck');
  assert.ok(deckIndex >= 0);
  assert.equal(this.questionsAfter.slice(this.questionsBefore.length).includes(`d${deckIndex}_loader`), false);
});

When('I request canvas insights twice', async function () {
  await configureJev(this);
  const first = await request(this, `/api/canvases/${this.canvasId}/insights`, 'POST', { query: '' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  this.questionsAfterFirst = await questionLog(this);
  const second = await request(this, `/api/canvases/${this.canvasId}/insights`, 'POST', { query: '' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  this.questionsAfterSecond = await questionLog(this);
});

Then('the second request sends no document questions to Jev', function () {
  const secondQuestions = this.questionsAfterSecond.slice(this.questionsAfterFirst.length);
  assert.equal(secondQuestions.some(id => /^d\d+_/.test(id)), false, secondQuestions.join(', '));
});

When('I add two near-identical documents {string} and {string} and link {string} to {string}', async function (firstTitle, secondTitle, sourceTitle, targetTitle) {
  await emptyWorkspace(this, ['Duplicate documents']);
  const content = '# Setup\n\nInstall the client and check configuration. These steps prepare the service for production.\n';
  for (const title of [firstTitle, secondTitle]) {
    const response = await request(this, `/api/canvases/${this.canvasId}/blocks`, 'POST', { title, content, kind: 'markdown' });
    assert.equal(response.status, 201);
  }
  const source = await request(this, `/api/canvases/${this.canvasId}/blocks`, 'POST', { title: sourceTitle, content: '# Readme\nSee setup instructions.' });
  assert.equal(source.status, 201);
  const target = await canvasBlock(this, targetTitle);
  const linked = await request(this, `/api/canvases/${this.canvasId}/blocks/${source.body.id}`, 'PUT', { links: [target.id] });
  assert.equal(linked.status, 200);
  this.mergeOriginal = await canvasBlock(this, firstTitle);
  this.mergeTarget = await canvasBlock(this, secondTitle);
  await configureJev(this, true);
});

When('I choose Merge in chat on the duplicate suggestion and apply the merge', async function () {
  const candidates = await request(this, `/api/canvases/${this.canvasId}/duplicates`, 'POST', {});
  assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
  const suggestion = candidates.body.find(item => item.action?.keepBlockId === this.mergeTarget.id
    && item.action?.mergeBlockIds.includes(this.mergeOriginal.id));
  assert.ok(suggestion, 'Expected a reviewable duplicate suggestion that keeps Setup v2');
  await ensureBrowserBuild();
  this.browser = await chromium.launch({ headless: true });
  this.page = await this.browser.newPage();
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.goto(`${this.baseUrl}/?canvas=${this.canvasId}`, { waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Insights' }).click();
  const finder = this.page.getByRole('region', { name: 'Find duplicates' });
  await finder.getByLabel('Document to check for duplicates').selectOption(this.mergeOriginal.id);
  await finder.getByRole('button', { name: 'Find duplicates' }).click();
  await finder.getByRole('button', { name: 'Merge in chat' }).click();
  const review = this.page.getByRole('dialog', { name: 'Review merge draft' });
  await review.waitFor();
  await review.getByRole('region', { name: 'Proposed changes' }).waitFor();
  await review.getByRole('button', { name: 'Apply merge' }).click();
  await review.waitFor({ state: 'hidden' });
  assert.deepEqual(this.pageErrors, []);
});

Then('only {string} is visible', async function (title) {
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  assert.equal(canvas.blocks.some(block => block.title === title), true);
  assert.equal(canvas.blocks.some(block => block.id === this.mergeOriginal.id), false);
  assert.equal(canvas.blocks.some(block => block.id === this.mergeTarget.id), true);
  await this.page.reload({ waitUntil: 'networkidle' });
  assert.equal(await this.page.locator('.canvas-card__identity strong', { hasText: title }).count(), 1);
  assert.deepEqual(this.pageErrors, []);
});

Then('{string} links to {string}', async function (fromTitle, toTitle) {
  const from = await canvasBlock(this, fromTitle);
  const to = await canvasBlock(this, toTitle);
  assert.ok(from.links.includes(to.id));
});

Then('the history of {string} still has its last content', async function (title) {
  const archived = this.mergeOriginal;
  assert.equal(archived.title, title);
  const response = await request(this, `/api/canvases/${this.canvasId}/blocks/${archived.id}/versions`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.commits?.length > 0);
  const stored = await readFile(join(this.dataDir, archived.file), 'utf8');
  assert.equal(stored, archived.content);
});

When('the assistant asks to delete {string} and I reply {string}', async function (title, reply) {
  const created = await request(this, `/api/canvases/${this.canvasId}/blocks`, 'POST', { title, content: '# Temporary\nDelete after approval.' });
  assert.equal(created.status, 201);
  await configureJev(this, true);
  const response = await fetch(`${this.baseUrl}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ canvasId: this.canvasId, messages: [
      { role: 'user', content: `Can you remove ${title}?` },
      { role: 'assistant', content: `I can delete ${title} from this canvas. Should I do that?` },
      { role: 'user', content: reply },
    ] }) });
  const stream = await response.text();
  assert.equal(response.status, 200, stream);
  assert.match(stream, /Deleted Temporary Note/);
});

Then('{string} is deleted', async function (title) {
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  assert.equal(canvas.blocks.some(block => block.title === title), false);
});

Given('two canvases with related documents {string} and {string}', async function (firstTitle, secondTitle) {
  await emptyWorkspace(this, ['API design', 'Billing']);
  const content = '# API client\n\nThe API client uses rate limits and billing quotas. Check the quota before each request.';
  const first = await request(this, `/api/canvases/${this.canvasIds[0]}/blocks`, 'POST', { title: firstTitle, content });
  const second = await request(this, `/api/canvases/${this.canvasIds[1]}/blocks`, 'POST', { title: secondTitle, content });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  this.firstCrossBlock = first.body;
  this.secondCrossBlock = second.body;
  await configureJev(this);
});

When('I run Connect across canvases with a confident Jev relation', async function () {
  const result = await request(this, `/api/canvases/${this.canvasId}/automations`, 'POST', { kind: 'cross_connect' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const first = await canvasBlock(this, this.firstCrossBlock.title);
  assert.ok(first.crossLinks?.some(link => link.canvasId === this.canvasIds[1] && link.blockId === this.secondCrossBlock.id));
  await ensureBrowserBuild();
  this.browser = await chromium.launch({ headless: true });
  this.page = await this.browser.newPage();
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.goto(`${this.baseUrl}/?canvas=${this.canvasId}`, { waitUntil: 'networkidle' });
  await this.page.locator('.canvas-surface').waitFor();
});

When('I choose the cross-canvas chip on {string}', async function (title) {
  const card = this.page.locator('.canvas-card').filter({ has: this.page.locator('.canvas-card__identity strong', { hasText: title }) });
  await card.getByRole('button', { name: `Open related document ${this.secondCrossBlock.id} on canvas ${this.canvasIds[1]}` }).click();
});

Then('the {string} document opens on its own canvas', async function (title) {
  await this.page.getByRole('dialog', { name: `${title} full page` }).waitFor();
  assert.match(this.page.url(), new RegExp(`canvas=${this.canvasIds[1]}`));
  assert.match(this.page.url(), new RegExp(`doc=${this.secondCrossBlock.id}`));
  assert.deepEqual(this.pageErrors, []);
});

Given('two canvases with unlabeled documents', async function () {
  await emptyWorkspace(this, ['Project plan', 'Project delivery']);
  for (const [index, canvasId] of this.canvasIds.entries()) {
    const result = await request(this, `/api/canvases/${canvasId}/blocks`, 'POST', {
      title: index === 0 ? 'Backend API plan' : 'Frontend client plan', content: '# Plan\nBuild and test the product API client.',
    });
    assert.equal(result.status, 201);
  }
  await configureJev(this);
});

When('I preview Classify work areas for the workspace', async function () {
  const result = await request(this, `/api/workspaces/${this.workspaceId}/automations`, 'POST', { kind: 'work_area' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.dryRun, true);
  assert.ok(result.body.changes.length >= 2);
  this.workspacePreview = result.body;
});

Then('no document is labeled', async function () {
  for (const canvasId of this.canvasIds) {
    const canvas = (await request(this, `/api/canvases/${canvasId}`)).body;
    assert.ok(canvas.blocks.every(block => !block.workArea));
  }
});

When('I apply the selected changes', async function () {
  const ids = this.workspacePreview.changes.map(change => change.id);
  const result = await request(this, `/api/workspaces/${this.workspaceId}/automations`, 'POST', {
    kind: 'work_area', dryRun: false, runId: this.workspacePreview.runId, actionIds: ids,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.applied, ids);
});

Then('the selected documents are labeled', async function () {
  for (const canvasId of this.canvasIds) {
    const canvas = (await request(this, `/api/canvases/${canvasId}`)).body;
    assert.ok(canvas.blocks.every(block => Boolean(block.workArea)));
  }
});

When('I undo the run', async function () {
  const result = await request(this, `/api/jev-runs/${this.workspacePreview.runId}/undo`, 'POST');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.reverted.length, this.workspacePreview.changes.length);
});
