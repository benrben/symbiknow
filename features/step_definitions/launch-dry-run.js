import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'playwright/test';
import { Given, When, Then } from '@cucumber/cucumber';

async function request(world, route, method = 'GET', body) {
  const response = await fetch(`${world.baseUrl}/api${route}`, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
const topicFor = filename => /pricing/.test(filename) ? 'Pricing'
  : /access|pen-test|sso/.test(filename) ? 'Security' : 'Release';
const card = (world, block) => world.page.locator(`.react-flow__node-document[data-id="${block.id}"] .canvas-card`);

Given('a fresh Dry run canvas with the synthetic launch provider', async function () {
  const workspace = await request(this, '/workspaces', 'POST', { name: 'Exact launch acceptance' });
  this.launchWorkspaceId = workspace.id;
  this.canvasId = (await request(this, `/workspaces/${workspace.id}/canvases`, 'POST', { name: 'Dry run' })).id;
  await request(this, '/settings', 'PUT', { secrets: { TYPESAFE_API_KEY: 'acceptance-launch-key' } });
});

When('I upload the eight exact launch files in alphabetical order', async function () {
  const directory = path.resolve('features/fixtures/launch-dry-run');
  const files = (await readdir(directory)).filter(file => file.endsWith('.md')).sort();
  assert.equal(files.length, 8); this.launchSources = [];
  for (const [index, filename] of files.entries()) {
    const content = await readFile(path.join(directory, filename), 'utf8');
    const saved = await request(this, `/canvases/${this.canvasId}/blocks`, 'POST', { kind: 'markdown',
      title: content.split('\n')[0].replace(/^#\s+/, ''), content, x: (index % 4) * 480, y: Math.floor(index / 4) * 420 });
    assert.ok(!saved.tags?.length && !saved.group); this.launchSources.push({ filename, content, id: saved.id, title: saved.title });
  }
});

Then('all eight launch files automatically settle into their shared main topics', async function () {
  await expect.poll(async () => {
    const state = await request(this, `/workspaces/${this.launchWorkspaceId}/jev/state`);
    return this.launchSources.every(source => state.profiles[`${this.canvasId}:${source.id}`])
      && state.jobs.every(job => !['queued', 'running'].includes(job.state));
  }, { timeout: 30000 }).toBe(true);
  this.launchSaved = await request(this, `/canvases/${this.canvasId}`);
  for (const source of this.launchSources) {
    const saved = this.launchSaved.blocks.find(block => block.id === source.id);
    const topic = topicFor(source.filename);
    assert.equal(saved.content, source.content); assert.deepEqual(saved.tags, [topic]);
    assert.equal(saved.group, `custom:${topic.toLowerCase()}`); assert.ok(saved.jevMutationId);
  }
});

Then('the named launch dependencies and heading-only duplicate are saved', async function () {
  const block = filename => this.launchSaved.blocks.find(item => item.id === this.launchSources.find(source => source.filename === filename).id);
  const launch = block('launch-blockers.md'); const sso = block('sso-security-review.md');
  const copy = block('pricing-page-copy.md'); const decision = block('pricing-tiers-decision.md');
  assert.equal(copy.linkTypes?.[decision.id], 'prerequisite'); assert.equal(decision.linkTypes?.[sso.id], 'prerequisite');
  for (const filename of ['sso-security-review.md', 'pricing-page-copy.md', 'pen-test-findings.md', 'rollback-runbook.md']) {
    assert.ok(launch.links.includes(block(filename).id), `Missing named launch connection to ${filename}`);
  }
  this.launchDuplicates = [block('rollback-runbook.md'), block('rollback-steps-copy.md')];
  for (const [index, source] of this.launchDuplicates.entries()) {
    assert.ok(source.jevDuplicates.some(finding => finding.blockId === this.launchDuplicates[1 - index].id));
  }
});

Then('the launch canvas displays Reflex attribution useful links and both duplicate badges', async function () {
  for (const source of this.launchSources) await expect(card(this, source).getByLabel('Organized by Reflex', { exact: true })).toHaveText('Reflex did it');
  for (const [index, source] of this.launchDuplicates.entries()) {
    await expect(card(this, source).getByRole('button', { name: `Possible duplicate: ${this.launchDuplicates[1 - index].title}`, exact: true })).toBeVisible();
  }
  await expect(this.page.locator('.react-flow__edge').first()).toBeAttached();
  assert.deepEqual(this.pageErrors, []);
  await this.page.screenshot({ path: '/tmp/symbiknow-exact-launch.png' });
});

When('I reload the exact launch canvas', async function () {
  await this.page.reload({ waitUntil: 'networkidle' }); await this.page.locator('.canvas-surface').waitFor();
});

Then('its organization source bytes and duplicate references survive reload without browser errors', async function () {
  const canvas = await request(this, `/canvases/${this.canvasId}`);
  for (const source of this.launchSources) {
    const saved = canvas.blocks.find(block => block.id === source.id);
    const before = this.launchSaved.blocks.find(block => block.id === source.id);
    for (const field of ['content', 'tags', 'group', 'links', 'linkTypes', 'jevDuplicates', 'jevMutationId']) assert.deepEqual(saved[field], before[field]);
    await expect(card(this, source).getByLabel('Organized by Reflex', { exact: true })).toHaveText('Reflex did it');
  }
  assert.deepEqual(this.pageErrors, []);
});
