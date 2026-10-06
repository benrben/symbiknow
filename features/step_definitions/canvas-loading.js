import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Then, When } from '@cucumber/cucumber';
import { launchAcceptanceBrowser } from './browser-launch.js';

const selectedTitle = 'Cold release note';
const initialText = 'Initial document body loaded on demand';
const savedContent = '# Cold release note\n\nSaved through the real editor';
const outsideContent = '# Cold release note\n\nLatest edit made outside the app';

async function openReleaseGroup(world) {
  const navigation = world.page.getByRole('navigation', { name: 'Mini-map groups' });
  const details = navigation.locator('details');
  if ((await details.getAttribute('open')) === null) await navigation.locator('summary').click();
  await navigation.getByRole('button', { name: /Release journal/ }).click();
  await world.page.getByRole('button', { name: `Read ${selectedTitle} full page` }).waitFor();
}

async function readSelected(world, text) {
  await world.page.getByRole('button', { name: `Read ${selectedTitle} full page` }).click();
  const reader = world.page.getByRole('dialog', { name: `${selectedTitle} full page` });
  await reader.locator('.page-reader__content').getByText(text, { exact: true }).waitFor();
  assert.deepEqual(world.pageErrors, []);
  return reader;
}

When('I seed 600 grouped documents for a cold canvas load', async function () {
  const file = join(this.dataDir, 'canvases', `${this.canvasId}.json`);
  const canvas = JSON.parse(await readFile(file, 'utf8'));
  const blocks = Array.from({ length: 600 }, (_, index) => ({
    id: `cold-document-${index}`, title: index === 0 ? selectedTitle : `Cold document ${index}`,
    file: `docs/cold-document-${index}.md`, kind: 'markdown', width: 360, height: 260,
    x: index < 3 ? index * 420 : 4000 + ((index - 3) % 20) * 420,
    y: index < 3 ? 0 : 3000 + Math.floor((index - 3) / 20) * 340,
    links: [], group: index < 3 ? 'custom:release-journal' : `custom:team-${Math.floor((index - 3) / 21)}`,
  }));
  const padding = 'x'.repeat(50_000);
  await Promise.all(blocks.map((block, index) => writeFile(join(this.dataDir, block.file),
    `# ${block.title}\n\n${index === 0 ? initialText : `Body of document ${index}`}\n\n${padding}`)));
  await writeFile(file, JSON.stringify({ ...canvas, blocks }));
  this.coldTarget = blocks[0];
  this.coldGroupIds = blocks.slice(0, 3).map(block => block.id);
  this.coldCanvasName = canvas.name;
});

When('I open the large canvas while recording real document requests', async function () {
  this.browser = await launchAcceptanceBrowser();
  this.page = await this.browser.newPage({ viewport: { width: 1440, height: 900 } });
  this.pageErrors = [];
  await this.page.addInitScript(() => {
    window.canvasWindowErrors = [];
    window.addEventListener('error', event => window.canvasWindowErrors.push(event.message));
  });
  this.coldDocumentRequests = [];
  this.coldCanvasRequests = [];
  this.coldSummaries = [];
  this.coldResponseReads = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  this.page.on('request', request => {
    if (request.method() !== 'GET') return;
    const url = new URL(request.url());
    const document = url.pathname.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)$/);
    if (document?.[1] === this.canvasId) this.coldDocumentRequests.push(document[2]);
    if (url.pathname === `/api/canvases/${this.canvasId}`) this.coldCanvasRequests.push(url);
  });
  this.page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname !== `/api/canvases/${this.canvasId}` || url.searchParams.get('summary') !== '1') return;
    this.coldResponseReads.push(response.json().then(body => {
      this.coldSummaries.push({ body, headers: response.headers(), status: response.status() });
    }));
  });
  this.coldLoadStarted = Date.now();
  await this.page.goto(`${this.baseUrl}/?canvas=${this.canvasId}`, { waitUntil: 'networkidle' });
  await this.page.locator('.canvas-surface--overview').waitFor();
  this.coldOverviewMilliseconds = Date.now() - this.coldLoadStarted;
});

Then('the initial overview contains fresh metadata and reads no document bodies', async function () {
  await Promise.all(this.coldResponseReads);
  assert.ok(this.coldSummaries.length > 0, 'The browser must request a summary');
  assert.ok(this.coldCanvasRequests.every(url => url.searchParams.get('summary') === '1'));
  const summary = this.coldSummaries[0];
  assert.equal(summary.status, 200);
  assert.equal(summary.headers['cache-control'], 'no-store');
  assert.equal(summary.headers.etag, undefined);
  assert.equal(summary.body.blocks.length, 600);
  assert.ok(summary.body.blocks.every(block => block.content === '' && block.contentLoaded === false));
  console.log('CANVAS_LOADING_EVIDENCE ' + JSON.stringify({ documents: 600,
    summaryBytes: Buffer.byteLength(JSON.stringify(summary.body)), initialDocumentRequests: this.coldDocumentRequests.length,
    overviewMilliseconds: this.coldOverviewMilliseconds }));
  assert.equal(this.coldDocumentRequests.length, 0, 'The initial group overview must not read file bodies');
  assert.equal(await this.page.locator('.canvas-card').count(), 0);
  assert.deepEqual(this.pageErrors, []);
});

When('I open Reflex on the large canvas', async function () {
  this.coldReflexStarted = Date.now();
  await this.page.getByRole('tab', { name: 'Symbi Reflex', exact: true }).click();
  const thresholds = this.page.getByRole('region', { name: 'Automatic action thresholds', exact: true });
  await thresholds.getByRole('spinbutton', { name: 'Understand documents confidence threshold', exact: true }).waitFor({ timeout: 2000 });
  this.coldReflexMilliseconds = Date.now() - this.coldReflexStarted;
});

Then('all six confidence controls appear without fetching full canvas content', async function () {
  const panel = this.page.getByRole('region', { name: 'Symbi Reflex organization', exact: true });
  assert.equal(await panel.getByRole('spinbutton').count(), 6);
  assert.equal(await this.page.locator('.canvas-surface--overview').count(), 1);
  assert.ok(this.coldCanvasRequests.every(url => url.searchParams.get('summary') === '1'));
  assert.equal(this.coldDocumentRequests.length, 0, 'Opening Reflex must keep source bodies deferred');
  console.log('REFLEX_LOADING_EVIDENCE ' + JSON.stringify({ documents: 600, confidenceControls: 6,
    fullCanvasRequests: this.coldCanvasRequests.filter(url => url.searchParams.get('summary') !== '1').length,
    documentRequests: this.coldDocumentRequests.length, reflexMilliseconds: this.coldReflexMilliseconds }));
  assert.deepEqual(this.pageErrors, []);
});

When('I return to chat on the large canvas', async function () {
  await this.page.getByRole('tab', { name: 'Chat', exact: true }).click();
});

When('I open the small release group on the large canvas', async function () {
  await openReleaseGroup(this);
  await this.page.locator('.canvas-card', { hasText: initialText }).waitFor();
  await this.page.waitForLoadState('networkidle');
});

Then("only that group's visible documents are requested", async function () {
  const visibleIds = await this.page.locator('.react-flow__node-document').evaluateAll(nodes => nodes.map(node => node.dataset.id));
  assert.deepEqual([...new Set(this.coldDocumentRequests)].sort(), visibleIds.sort());
  assert.deepEqual(visibleIds, [...this.coldGroupIds].sort());
  assert.ok(this.coldDocumentRequests.length < 600);
  assert.deepEqual(this.pageErrors, []);
});

When('I read and edit the selected cold document', async function () {
  const reader = await readSelected(this, initialText);
  await reader.getByRole('button', { name: 'Edit document' }).click();
  const editor = this.page.getByRole('dialog', { name: 'Block editor' });
  await editor.waitFor({ timeout: 10_000 });
  await editor.getByLabel('Markdown source').getByText(initialText, { exact: true }).waitFor();
  await editor.getByLabel('Markdown source').fill(savedContent);
  await editor.getByRole('button', { name: 'Save block' }).click();
  await editor.waitFor({ state: 'hidden' });
});

Then('its edit survives disk readback and a browser reload', async function () {
  assert.equal(await readFile(join(this.dataDir, this.coldTarget.file), 'utf8'), savedContent);
  const response = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}/blocks/${this.coldTarget.id}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, savedContent);
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.locator('.canvas-surface--overview').waitFor();
  await openReleaseGroup(this);
  const reader = await readSelected(this, 'Saved through the real editor');
  await reader.getByRole('button', { name: '← Back to canvas' }).click();
  await reader.waitFor({ state: 'hidden' });
  assert.deepEqual(this.pageErrors, []);
});

When('I change that document on disk and return from another canvas', async function () {
  await writeFile(join(this.dataDir, this.coldTarget.file), outsideContent);
  await this.page.getByRole('button', { name: 'Open canvas: Product Roadmap', exact: true }).click();
  await this.page.locator('.canvas-label').getByRole('heading', { name: 'Product Roadmap' }).waitFor();
  this.coldRequestsBeforeReturn = this.coldDocumentRequests.filter(id => id === this.coldTarget.id).length;
  const documentCountBeforeReturn = this.coldDocumentRequests.length;
  await this.page.getByRole('button', { name: `Open canvas: ${this.coldCanvasName}`, exact: true }).click();
  await this.page.locator('.canvas-surface--overview').waitFor();
  await this.page.waitForLoadState('networkidle');
  assert.equal(this.coldDocumentRequests.length, documentCountBeforeReturn, 'Returning to the overview must keep document bodies deferred');
  await openReleaseGroup(this);
});

Then('the reader shows the fresh outside edit without a cached body', async function () {
  await readSelected(this, 'Latest edit made outside the app');
  assert.ok(this.coldDocumentRequests.filter(id => id === this.coldTarget.id).length > this.coldRequestsBeforeReturn);
  assert.deepEqual(this.pageErrors, []);
});

When('I seed 158 ungrouped responsive HTML sources', async function () {
  const file = join(this.dataDir, 'canvases', `${this.canvasId}.json`);
  const canvas = JSON.parse(await readFile(file, 'utf8'));
  this.richSource = '---\nformat: html\n---\n<!doctype html><html><head><style>'
    + 'html,body{margin:0}body{font:16px system-ui}.hero{padding:32px;background:#e8f3f0}'
    + '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{padding:24px;background:#eef}'
    + '@media(max-width:520px){.hero{padding:16px}h1{font-size:28px}}'
    + '</style></head><body><header class="hero"><span>Platform · API</span><h1>Responsive technical source</h1>'
    + '<p>The server preserves canonical source files and checked history.</p></header><main class="grid">'
    + '<article class="card"><h2>Source evidence</h2><p>Clients receive current documents through the API.</p></article>'.repeat(12)
    + '</main></body></html>';
  this.richBlocks = Array.from({ length: 158 }, (_, index) => ({
    id: `rich-document-${index}`, title: `Responsive source ${index}`, file: `docs/rich-document-${index}.md`,
    kind: 'markdown', width: 420, height: 320, x: 100, y: 100, links: [],
  }));
  await Promise.all(this.richBlocks.map(block => writeFile(join(this.dataDir, block.file), this.richSource)));
  await writeFile(file, JSON.stringify({ ...canvas, blocks: this.richBlocks }));
});

async function expandRichCanvas(world) {
  const navigation = world.page.getByRole('navigation', { name: 'Mini-map groups' });
  if ((await navigation.locator('details').getAttribute('open')) === null) await navigation.locator('summary').click();
  await navigation.getByRole('button', { name: /Ungrouped/ }).click();
  await world.page.locator('.canvas-card').last().waitFor();
  await world.page.waitForFunction(() => document.querySelectorAll('.canvas-card iframe').length === 158);
  await world.page.locator('.canvas-surface--full').waitFor();
}

When('I expand the rich Ungrouped canvas and resize its viewport', async function () {
  await expandRichCanvas(this);
  for (const width of [1000, 899, 700, 519, 950, 1440]) {
    await this.page.setViewportSize({ width, height: 900 });
    await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await this.page.waitForLoadState('networkidle');
});

Then('the rich previews and Reflex controls remain usable without browser errors', async function () {
  assert.equal(await this.page.locator('.canvas-card iframe').count(), 158);
  assert.equal(this.coldDocumentRequests.length, 158);
  await this.page.getByRole('tab', { name: 'Symbi Reflex', exact: true }).click();
  const thresholds = this.page.getByRole('region', { name: 'Automatic action thresholds', exact: true });
  await thresholds.getByRole('spinbutton', { name: 'Understand documents confidence threshold', exact: true }).waitFor();
  assert.equal(await thresholds.getByRole('spinbutton').count(), 6);
  await this.page.getByRole('tab', { name: 'Chat', exact: true }).click();
  assert.equal(await this.page.locator('.canvas-card iframe').count(), 158);
  assert.deepEqual(await this.page.evaluate(() => window.canvasWindowErrors), []);
  assert.deepEqual(this.pageErrors, []);
});

When('I reload the expanded rich canvas', async function () {
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.locator('.canvas-surface--overview').waitFor();
  await expandRichCanvas(this);
  await this.page.waitForLoadState('networkidle');
});

Then('its original source bytes and dimensions remain unchanged', async function () {
  const response = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}?summary=1`);
  assert.equal(response.status, 200);
  const canvas = await response.json();
  assert.deepEqual(canvas.blocks.map(block => ({ id: block.id, x: block.x, y: block.y, width: block.width, height: block.height })),
    this.richBlocks.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })));
  assert.ok((await Promise.all(this.richBlocks.map(block => readFile(join(this.dataDir, block.file), 'utf8'))))
    .every(content => content === this.richSource));
  assert.equal(await this.page.locator('.canvas-card iframe').count(), 158);
  assert.deepEqual(await this.page.evaluate(() => window.canvasWindowErrors), []);
  assert.deepEqual(this.pageErrors, []);
});
