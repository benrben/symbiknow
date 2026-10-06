import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Then, When } from '@cucumber/cucumber';

async function waitForBlockInView(page, title) {
  try { await page.waitForFunction((name) => {
    const surface = document.querySelector('.answer-canvas__workspace .canvas-flow-stage')?.getBoundingClientRect();
    const block = [...document.querySelectorAll('.answer-canvas__workspace .react-flow__node-document')]
      .find(node => node.textContent?.includes(name))?.getBoundingClientRect();
    return surface && block && block.left >= surface.left && block.right <= surface.right
      && block.top >= surface.top && block.bottom <= surface.bottom;
  }, title, { timeout: 4000 }); }
  catch (failure) {
    const position = await page.evaluate(name => {
      const surface = document.querySelector('.answer-canvas__workspace .canvas-flow-stage')?.getBoundingClientRect();
      const block = [...document.querySelectorAll('.answer-canvas__workspace .react-flow__node-document')]
        .find(node => node.textContent?.includes(name))?.getBoundingClientRect();
      return { surface: surface?.toJSON(), block: block?.toJSON(), viewport: innerWidth };
    }, title);
    throw new Error(`${failure.message}: ${JSON.stringify(position)}`);
  }
}

async function isolateSavedEvidence(world) {
  const workspaces = await fetch(`${world.baseUrl}/api/workspaces`).then(response => response.json());
  const workspace = workspaces.find(item => item.canvases.some(canvas => canvas.id === world.canvasId));
  assert.ok(workspace);
  // These scenarios have one reusable source. Hide the unrelated starter documents
  // through the public API while retaining their canvases for navigation.
  for (const summary of workspace.canvases) {
    const canvas = await fetch(`${world.baseUrl}/api/canvases/${summary.id}`).then(response => response.json());
    for (const block of canvas.blocks.filter(item => item.id !== world.block.id && !item.archived)) {
      const response = await fetch(`${world.baseUrl}/api/canvases/${canvas.id}/blocks/${block.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).archived, true);
    }
  }
}

When('I configure chat for the conversation canvas', async function () {
  await isolateSavedEvidence(this);
  const response = await fetch(`${this.baseUrl}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-4o-mini', apiKey: 'acceptance-chat-key' }) });
  assert.equal(response.status, 200);
});

function observeChatRequests(world) {
  if (world.answerCanvasRequests) return;
  world.answerCanvasRequests = [];
  world.page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/chat/stream' && request.method() === 'POST') {
      world.answerCanvasRequests.push(request.postDataJSON());
    }
  });
}

async function assertNativeResearch(world, count) {
  const records = (await readFile(join(world.dataDir, 'chat-research.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const result = records.at(-1);
  assert.equal(result.sourceId, `${world.canvasId}:${world.block.id}`);
  assert.equal(result.sourceTitle, 'Launch evidence');
  assert.deepEqual(result.drawResult, { drawn: true, blocks: count, edges: count === 3 ? 2 : 0 });
}

When('I ask {string} with selected evidence', async function (question) {
  observeChatRequests(this);
  const evidence = this.page.locator('.canvas-card').filter({ hasText: this.block.title }).first();
  if (await evidence.isVisible()) await evidence.click();
  await this.page.getByRole('textbox', { name: 'Message Symbi' }).fill(question);
  await this.page.getByRole('button', { name: 'Submit' }).click();
  await this.page.getByRole('complementary', { name: 'Symbi assistant' })
    .getByRole('button', { name: /Open research canvas · 3 new blocks/ }).last().waitFor();
  await assertNativeResearch(this, 3);
});

Then('the conversation canvas has {int} answers and one reusable source', async function (count) {
  const board = this.page.getByRole('region', { name: 'Research canvas', exact: true });
  await board.waitFor();
  await board.getByText(new RegExp(`${count * 3} documents · 1 cited source`, 'u')).waitFor();
  await board.locator('.canvas-card').nth(2).waitFor();
  assert.ok(await board.locator('.canvas-card').count() >= 3);
  if (await board.locator('.answer-canvas__outline').getAttribute('open') === null) {
    await board.locator('.answer-canvas__outline summary').click();
  }
  await board.getByRole('button', { name: `Step 1: Finding ${count}` }).click();
  await board.getByText('Files · 100%').waitFor({ timeout: 6000 });
  const relatedCards = board.locator('.canvas-card:has(.canvas-card__relationships)');
  await relatedCards.first().waitFor({ timeout: 6000 });
  assert.ok(await relatedCards.count() >= 2);
  await relatedCards.first().getByRole('button', { name: /Read .* full page/u }).focus();
  await relatedCards.first().getByRole('navigation', { name: /Relationships for/u }).waitFor({ state: 'visible' });
  assert.ok(await board.locator('.canvas-card').filter({ hasText: 'Launch flow' }).count() >= 1);
  assert.equal(await board.getByRole('navigation', { name: 'Research questions' }).getByRole('button').count(), count > 1 ? count : 0);
  await board.locator('.loader-mermaid svg').first().waitFor({ timeout: 10000 });
  assert.equal(await board.locator('.canvas-surface').count(), 1);
  if (count === 2) await this.page.screenshot({ path: '.quality/conversation-canvas.png' });
  assert.deepEqual(this.pageErrors, []);
});

When('I visit another canvas and continue the conversation', async function () {
  await this.page.getByRole('button', { name: 'Return to main canvas' }).click();
  await this.page.getByRole('region', { name: 'Research canvas', exact: true }).waitFor({ state: 'hidden' });
  await this.page.getByText('Product Roadmap', { exact: true }).click();
  await this.page.getByRole('heading', { name: 'Product Roadmap' }).first().waitFor();
});

Then('I can reopen the accumulated conversation canvas', async function () {
  await this.page.getByRole('button', { name: 'Open research canvas', exact: true }).getByText('Research canvas').waitFor();
  await this.page.getByRole('button', { name: 'Open research canvas', exact: true }).click();
  const board = this.page.getByRole('region', { name: 'Research canvas', exact: true });
  await board.waitFor();
  await board.getByRole('button', { name: 'Question 2: Map which tests failed and how they block the launch' }).click();
  await waitForBlockInView(this.page, 'Finding 2');
  await board.getByRole('button', { name: 'Question 1: What blocks the launch?' }).click();
  await waitForBlockInView(this.page, 'Finding 1');
  await board.getByRole('button', { name: 'Question 2: Map which tests failed and how they block the launch' }).click();
  await waitForBlockInView(this.page, 'Finding 2');
  assert.equal(this.answerCanvasRequests.length, 2);
  assert.deepEqual(this.pageErrors, []);
});

Then('the research canvas uses dark surfaces and retains every block', async function () {
  const board = this.page.getByRole('region', { name: 'Research canvas', exact: true });
  const color = await board.locator('.answer-canvas__workspace .react-flow').evaluate(element => getComputedStyle(element).backgroundColor);
  const cardColor = await board.locator('.canvas-card').first().evaluate(element => getComputedStyle(element).backgroundColor);
  assert.equal(await this.page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(color, 'rgb(32, 37, 36)');
  assert.notEqual(cardColor, 'rgb(255, 255, 255)');
  await board.getByText(/6 documents · 1 cited source/u).waitFor();
  assert.ok(await board.locator('.canvas-card').count() >= 1);
  await board.locator('.loader-mermaid svg').first().waitFor();
  await this.page.screenshot({ path: '.quality/conversation-canvas-dark.png' });
  assert.deepEqual(this.pageErrors, []);
});

Then('the research canvas shows its answer structure with secondary controls tucked away', async function () {
  const board = this.page.getByRole('region', { name: 'Research canvas', exact: true });
  if (await board.locator('.answer-canvas__outline').getAttribute('open') === null) {
    await board.locator('.answer-canvas__outline summary').click();
  }
  const story = board.getByLabel('Latest answer structure');
  await story.getByRole('button', { name: 'Step 1: Finding 2' }).waitFor();
  assert.match(await story.textContent(), /Finding 2.*Launch flow 2.*Next action 2/u);
  assert.equal(await board.getByRole('button', { name: 'Export Markdown' }).isVisible(), false);
  await board.locator('.answer-canvas__more summary').click();
  assert.equal(await board.getByRole('button', { name: 'Export Markdown' }).isVisible(), true);
  await board.locator('.answer-canvas__more summary').click();
  assert.deepEqual(this.pageErrors, []);
});

When('I ask a direct factual question in chat', async function () {
  await this.page.getByRole('textbox', { name: 'Message Symbi' }).fill('Which tests failed?');
  await this.page.getByRole('button', { name: 'Submit' }).click();
});

Then('the direct answer stays in chat and adds no research block', async function () {
  await this.page.getByText('The mobile release has two failing tests.', { exact: true }).waitFor();
  const board = this.page.getByRole('region', { name: 'Research canvas', exact: true });
  await board.getByText(/6 documents · 1 cited source/u).waitFor();
  assert.equal(await board.getByRole('navigation', { name: 'Research questions' }).getByRole('button').count(), 2);
  assert.deepEqual(this.pageErrors, []);
});

Then('the assistant shows its current scope and a way to turn the answer into a map', async function () {
  const assistant = this.page.getByRole('complementary', { name: 'Symbi assistant' });
  await assistant.getByRole('button', { name: 'Choose assistant context' }).waitFor();
  assert.match(await assistant.getByRole('button', { name: 'Choose assistant context' }).textContent(), /Research canvas/u);
  assert.equal(await assistant.getByRole('button', { name: 'Turn this into a map' }).isVisible(), true);
  assert.deepEqual(this.pageErrors, []);
});

Then('I can add, read, search, undo, and save with the normal canvas controls', async function () {
  const board = this.page.getByRole('region', { name: 'Research canvas', exact: true });
  await board.locator('.canvas-surface').waitFor();
  assert.equal(await board.locator('.canvas-surface .react-flow__minimap').count(), 1);
  await this.page.getByRole('button', { name: 'Create note', exact: true }).click();
  const editor = this.page.getByRole('dialog', { name: 'Document editor' });
  await editor.waitFor();
  await editor.getByLabel('Title').fill('My field note');
  await editor.getByRole('button', { name: 'Save document' }).click();
  await board.getByText(/4 documents · 1 cited source/u).waitFor();
  await board.getByRole('button', { name: 'Read My field note full page' }).waitFor();
  const original = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}`).then(response => response.json());
  assert.equal(original.blocks.length, 1);

  await board.getByRole('button', { name: 'Read My field note full page' }).click();
  const reader = this.page.getByRole('dialog', { name: 'My field note full page' });
  await reader.waitFor();
  await reader.getByRole('button', { name: 'Back to canvas' }).click();
  await board.getByRole('button', { name: 'Edit My field note' }).click();
  await editor.getByLabel('Title').fill('Edited field note');
  await editor.getByRole('button', { name: 'Save document' }).click();
  await board.getByRole('button', { name: 'Read Edited field note full page' }).waitFor();

  await this.page.getByRole('button', { name: 'Search documents' }).click();
  const search = board.getByRole('textbox', { name: 'Find in research canvas' });
  await search.focus();
  assert.equal(await search.evaluate(element => element === document.activeElement), true);
  await search.fill('Launch flow');
  await board.getByRole('group', { name: 'Research search results' }).getByRole('button', { name: 'Launch flow 1' }).waitFor();
  await search.clear();

  await board.getByRole('button', { name: 'Undo', exact: true }).click();
  await board.getByRole('button', { name: 'Read My field note full page' }).waitFor();
  await board.getByRole('button', { name: 'Undo', exact: true }).click();
  await board.getByText(/3 documents · 1 cited source/u).waitFor();
  await this.page.locator('.topbar input[type="file"]').setInputFiles({
    name: 'Research attachment.md', mimeType: 'text/markdown', buffer: Buffer.from('# Attachment\n\nA local finding.'),
  });
  await board.getByText(/4 documents · 1 cited source/u).waitFor();
  await board.getByRole('button', { name: 'Undo', exact: true }).click();
  await board.getByText(/3 documents · 1 cited source/u).waitFor();
  await this.page.getByRole('button', { name: 'Create note', exact: true }).click();
  await editor.getByLabel('Title').fill('Saved research note');
  await editor.getByRole('button', { name: 'Save document' }).click();
  await board.getByText(/4 documents · 1 cited source/u).waitFor();
  await board.locator('.canvas-card').filter({ hasText: 'Saved research note' }).click();
  const inspector = board.getByRole('complementary', { name: 'Selection inspector' });
  await inspector.getByRole('tab', { name: 'Details' }).click();
  await inspector.getByLabel('Connection target').selectOption({ label: 'Finding 1' });
  await inspector.getByRole('button', { name: 'Connect selected' }).click();
  await board.getByRole('button', { name: 'Save canvas' }).click();
  await board.getByText(/Saved as Research/u).waitFor();
  const workspaces = await fetch(`${this.baseUrl}/api/workspaces`).then(response => response.json());
  const savedSummary = workspaces.flatMap(workspace => workspace.canvases).find(item => item.name.startsWith('Research — What blocks the launch?'));
  assert.ok(savedSummary);
  const saved = await fetch(`${this.baseUrl}/api/canvases/${savedSummary.id}`).then(response => response.json());
  assert.equal(saved.blocks.length, 4);
  assert.ok(saved.blocks.some(block => block.title === 'Saved research note'));
  assert.ok(saved.blocks.find(block => block.title === 'Saved research note').links
    .includes(saved.blocks.find(block => block.title === 'Finding 1').id));
  const viewport = board.locator('.react-flow__viewport');
  const previousViewport = await viewport.getAttribute('style');
  await this.page.getByRole('button', { name: 'Browse groups', exact: true }).click();
  await this.page.waitForFunction(previous => {
    const style = document.querySelector('[aria-label="Research canvas"] .react-flow__viewport')?.getAttribute('style');
    return style !== previous && /scale\(0\.28\)/u.test(style ?? '');
  }, previousViewport);
  assert.match(await viewport.getAttribute('style') ?? '', /scale\(0\.28\)/u);
  await this.page.setViewportSize({ width: 1120, height: 688 });
  await board.getByRole('button', { name: 'Step 1: Finding 1' }).click();
  await board.getByText(/Files · (?:[7-9]\d|100)%/u).waitFor({ timeout: 6000 });
  await waitForBlockInView(this.page, 'Finding 1');
  await this.page.screenshot({ path: '.quality/research-canvas-small.png' });
  assert.deepEqual(this.pageErrors, []);
});

When('I ask for rich research blocks', async function () {
  observeChatRequests(this);
  await this.page.getByRole('textbox', { name: 'Message Symbi' }).fill('Show me every format on a temporary research canvas');
  await this.page.getByRole('button', { name: 'Submit' }).click();
  await this.page.getByRole('region', { name: 'Research canvas', exact: true }).getByText('6 documents · 1 cited source', { exact: false }).waitFor();
  await assertNativeResearch(this, 6);
});

Then('I can view and save the rich blocks with their original formats', async function () {
  const board = this.page.getByRole('region', { name: 'Research canvas', exact: true });
  await board.locator('.answer-canvas__outline summary').click();
  const focus = async (index, title) => {
    await board.getByRole('button', { name: `Step ${index}: ${title}` }).click();
    const card = board.locator('.canvas-card').filter({ hasText: title });
    await card.waitFor();
    await waitForBlockInView(this.page, title);
    try { await card.locator('.canvas-card__body').waitFor({ timeout: 6000 }); }
    catch (failure) {
      const view = await board.evaluate((element) => ({
        label: element.querySelector('.canvas-zoom-label')?.textContent,
        transform: element.querySelector('.react-flow__viewport')?.getAttribute('style'),
      }));
      await this.page.screenshot({ path: '/tmp/symbiknow-rich-focus-failure.png' });
      throw new Error(`Research focus remained title-only for ${title}: ${JSON.stringify(view)}\n${String(failure)}`);
    }
    return card;
  };
  await (await focus(1, 'Visual evidence')).locator('img[alt="Launch status"]').waitFor();
  await (await focus(2, 'HTML report')).locator('iframe[title="HTML report HTML preview"]').waitFor();
  await board.frameLocator('iframe[title="HTML report HTML preview"]').getByRole('heading', { name: 'Rendered report' }).waitFor();
  await (await focus(3, 'System flow')).locator('.loader-mermaid svg').waitFor();
  await (await focus(4, 'Briefing slides')).locator('.loader-slides iframe').waitFor();
  const chart = await focus(5, 'Health chart');
  try { await chart.getByRole('img', { name: 'Release health: 2, 4, 6' }).waitFor(); }
  catch (failure) {
    await this.page.screenshot({ path: '/tmp/symbiknow-rich-chart-failure.png' });
    throw new Error(`Research chart did not render: ${await chart.innerText()}\n${String(failure)}`);
  }
  assert.deepEqual(await chart.locator('.mdx-chart__bars span').allTextContents(), ['2', '4', '6']);
  await this.page.screenshot({ path: '.quality/research-rich-blocks.png' });
  await (await focus(6, 'Documentation site')).getByText('Save this research canvas to build and preview the website.').waitFor();
  await board.getByRole('button', { name: 'Save canvas' }).click();
  await board.getByText(/Saved as Research/u).waitFor();
  const workspaces = await fetch(`${this.baseUrl}/api/workspaces`).then(response => response.json());
  const savedSummary = workspaces.flatMap(workspace => workspace.canvases)
    .find(item => item.name.startsWith('Research — Show me every format'));
  assert.ok(savedSummary);
  const saved = await fetch(`${this.baseUrl}/api/canvases/${savedSummary.id}`).then(response => response.json());
  const byTitle = new Map(saved.blocks.map(block => [block.title, block]));
  assert.equal(byTitle.get('Visual evidence')?.kind, 'markdown');
  assert.match(byTitle.get('Visual evidence')?.content, /!\[Launch status\]/u);
  assert.match(byTitle.get('HTML report')?.content, /^---\nformat: html\n---\n<!doctype html>/u);
  assert.equal(byTitle.get('Briefing slides')?.kind, 'slides');
  assert.equal(byTitle.get('Health chart')?.kind, 'mdx');
  assert.equal(byTitle.get('Documentation site')?.kind, 'website');
  assert.equal(byTitle.get('HTML report')?.crossLinks?.[0]?.blockId, this.block.id);
  assert.deepEqual(this.pageErrors, []);
});

When('I keep a chat draft while the canvas API becomes unreachable', async function () {
  const draft = this.page.getByRole('textbox', { name: 'Message Symbi' });
  await draft.fill('Help me investigate the failed release');
  await this.page.waitForFunction(() => sessionStorage.getItem('symbiknow:chat-draft') === 'Help me investigate the failed release');
  await this.page.route('**/api/workspaces', route => route.abort('failed'));
  await this.page.reload({ waitUntil: 'domcontentloaded' });
});

Then('I can reconnect without losing the chat draft', async function () {
  await this.page.getByRole('button', { name: 'Reconnect' }).waitFor();
  assert.equal(await this.page.getByRole('textbox', { name: 'Message Symbi' }).inputValue(),
    'Help me investigate the failed release');
  await this.page.unroute('**/api/workspaces');
  await this.page.getByRole('button', { name: 'Reconnect' }).click();
  await this.page.getByRole('heading', { name: 'Product Roadmap' }).first().waitFor();
  assert.equal(await this.page.getByRole('textbox', { name: 'Message Symbi' }).inputValue(),
    'Help me investigate the failed release');
  assert.deepEqual(this.pageErrors, []);
});
