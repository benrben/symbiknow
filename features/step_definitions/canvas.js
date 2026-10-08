import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { After, Before, Given, Then, When, setDefaultTimeout } from '@cucumber/cucumber';
import { launchAcceptanceBrowser } from './browser-launch.js';

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

Before({ tags: 'not @engine' }, async function () {
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

After({ tags: 'not @engine' }, async function () {
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
  this.browser = await launchAcceptanceBrowser();
  this.page = await this.browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.goto(this.baseUrl, { waitUntil: 'networkidle' });
  await this.page.locator('.canvas-surface').waitFor();
  this.lightCanvasColor = await this.page.locator('.canvas-surface').evaluate(element => getComputedStyle(element).backgroundColor);
});

When('I open the current canvas in a browser', async function () {
  await ensureBrowserBuild();
  this.browser = await launchAcceptanceBrowser();
  this.page = await this.browser.newPage({ viewport: { width: 1440, height: 900 } });
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.goto(`${this.baseUrl}/?canvas=${this.canvasId}`, { waitUntil: 'networkidle' });
  await this.page.locator('.canvas-surface').waitFor();
});

When('I save a new block titled {string}', async function (title) {
  await this.page.getByRole('button', { name: 'Create note' }).first().click();
  const editor = this.page.getByRole('dialog', { name: 'Document editor' });
  await editor.getByLabel('Title').fill(title);
  await editor.getByRole('button', { name: 'Save document' }).click();
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
  assert.equal(await this.page.getByRole('dialog', { name: 'Document editor' }).count(), 0);
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

When('I send a chat message then press New chat', async function () {
  await ensureBrowserBuild();
  this.browser = await launchAcceptanceBrowser();
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
  await this.page.getByRole('textbox', { name: 'Message Symbi' }).fill('First question');
  await this.page.getByRole('button', { name: 'Submit' }).click();
  await this.page.getByText('First answer.').waitFor();
  await this.page.getByRole('button', { name: 'New chat' }).click();
  await this.page.getByRole('button', { name: 'Discard and start' }).click();
  await this.page.getByRole('heading', { name: 'Hi, I’m Symbi.' }).waitFor();
  assert.equal(await this.page.getByText('First answer.').count(), 0);
  assert.deepEqual(this.pageErrors, []);
});

Then('the next chat request contains only the new message', async function () {
  await this.page.getByRole('textbox', { name: 'Message Symbi' }).fill('Second question');
  await this.page.getByRole('button', { name: 'Submit' }).click();
  await this.page.getByText('Second answer.').waitFor();
  assert.equal(this.chatRequests.length, 2);
  assert.deepEqual(this.chatRequests[1].messages, [{ role: 'user', content: 'Second question' }]);
  assert.deepEqual(this.pageErrors, []);
});

When('I drag the chat divider wider', async function () {
  await ensureBrowserBuild();
  this.browser = await launchAcceptanceBrowser();
  this.page = await this.browser.newPage({ viewport: { width: 1440, height: 900 } });
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.goto(this.baseUrl, { waitUntil: 'networkidle' });
  const panel = this.page.getByRole('complementary', { name: 'Symbi assistant' });
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
  const panel = this.page.getByRole('complementary', { name: 'Symbi assistant' });
  const reloadedWidth = (await panel.boundingBox()).width;
  assert.ok(Math.abs(reloadedWidth - this.resizedWidth) < 2);
  assert.deepEqual(this.pageErrors, []);
});

When('I upload an HTML page', async function () {
  await ensureBrowserBuild();
  this.browser = await launchAcceptanceBrowser();
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
  const editor = this.page.getByRole('dialog', { name: 'Document editor' });
  const unsaved = '---\nformat: html\n---\n<!doctype html><html><body><h1>Unsaved preview</h1></body></html>';
  await editor.getByLabel('Markdown source').fill(unsaved);
  await editor.getByRole('button', { name: 'Preview' }).click();
  const preview = editor.getByTitle('Landing HTML preview');
  assert.ok((await preview.getAttribute('srcdoc')).includes('Unsaved preview'));
  await editor.getByRole('button', { name: 'Source' }).click();
  assert.equal(await editor.getByLabel('Markdown source').evaluate(element =>
    [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')), unsaved);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await editor.getByRole('alertdialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Discard changes' }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.deepEqual(this.pageErrors, []);
});

Then('I can download its Markdown file and upload an edited version', async function () {
  const downloaded = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}/blocks/${this.htmlBlock.id}/download`);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  assert.equal(await downloaded.text(), this.htmlBlock.content);
  await this.page.getByRole('button', { name: 'Edit Landing' }).click();
  const editor = this.page.getByRole('dialog', { name: 'Document editor' });
  await editor.locator('input[type=file]').setInputFiles({ name: 'Landing.md', mimeType: 'text/markdown',
    buffer: Buffer.from('# Revised from disk\n') });
  await editor.getByLabel('Markdown source').getByText('# Revised from disk').waitFor();
  await editor.getByRole('button', { name: 'Save document' }).click();
  await editor.waitFor({ state: 'hidden' });
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  assert.equal(canvas.blocks.find(block => block.id === this.htmlBlock.id).content, '# Revised from disk\n');
  assert.deepEqual(this.pageErrors, []);
});

async function configureChat(world) {
  const result = await request(world, '/api/settings', 'PUT', {
    model: 'openai/gpt-4o-mini', apiKey: 'acceptance-chat-key',
  });
  assert.equal(result.status, 200);
}

When('the assistant asks to delete {string} and I reply {string}', async function (title, reply) {
  const created = await request(this, `/api/canvases/${this.canvasId}/blocks`, 'POST', { title, content: '# Temporary\nDelete after approval.' });
  assert.equal(created.status, 201);
  await configureChat(this);
  const response = await fetch(`${this.baseUrl}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ canvasId: this.canvasId, messages: [
      { role: 'user', content: `Can you remove ${title}?` },
      { role: 'assistant', content: `I can delete ${title} from this canvas. Should I do that?` },
      { role: 'user', content: reply },
    ] }) });
  const stream = await response.text();
  assert.equal(response.status, 200, stream);
  assert.match(stream, /Deleted Temporary Note through MCP/);
  assert.doesNotMatch(stream, /event: chat_proposal/);
});

Then('{string} is deleted through the canonical MCP tool', async function (title) {
  const canvas = (await request(this, `/api/canvases/${this.canvasId}`)).body;
  assert.equal(canvas.blocks.some(block => block.title === title), false);
});
