import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { launchAcceptanceBrowser } from './browser-launch.js';
import { createServer } from 'vite';

const run = promisify(execFile);
const poses = ['resting', 'moving', 'listening', 'talking', 'reading', 'writing', 'asking', 'thinking',
  'searching', 'connecting', 'organizing', 'comparing', 'checking', 'summarizing', 'working', 'done'];

function portrait(world, name) {
  return world.page.locator(`.avatar--hero > [data-avatar-name="${name}"]`);
}

async function motion(world) {
  return world.page.locator('.assistant-character, .assistant-character *').evaluateAll(nodes =>
    nodes.flatMap(node => [null, '::before', '::after'].map(pseudo => getComputedStyle(node, pseudo).animationName)));
}

After({ tags: '@avatar-preview' }, async function () {
  try {
    await this.avatarVite?.close();
  } finally {
    if (this.avatarViteCache) await rm(this.avatarViteCache, { recursive: true, force: true });
  }
});

Given('the real assistant artwork preview', async function () {
  await run(process.execPath, ['--import', 'tsx', 'scripts/sync-symbi-avatar-preview.ts']);
  this.avatarViteCache = await mkdtemp(join(tmpdir(), 'symbiknow-avatar-vite-'));
  this.avatarVite = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir: this.avatarViteCache,
    optimizeDeps: { noDiscovery: true, include: [], entries: ['brand/symbi-avatar-demo.html'] },
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await this.avatarVite.listen();
  const { port } = this.avatarVite.httpServer.address();
  this.browser = await launchAcceptanceBrowser();
  this.page = await this.browser.newPage({ viewport: { width: 1280, height: 900 } });
  this.pageErrors = [];
  this.page.on('pageerror', error => this.pageErrors.push(error.message));
  await this.page.goto(`http://127.0.0.1:${port}/brand/symbi-avatar-demo.html`);
  await portrait(this, 'Symbi').waitFor();
});

When('I preview every pose for Symbi and Symbi Reflex in both themes', async function () {
  this.avatarEvidence = [];
  for (const theme of ['dark', 'light']) {
    if (await this.page.locator('body').getAttribute('data-theme') !== theme) {
      await this.page.getByRole('button', { name: 'Light mode', exact: true }).click();
    }
    for (const name of ['Symbi', 'Symbi Reflex']) {
      const controls = this.page.getByRole('group', { name: `Preview ${name} animation` });
      assert.equal(await controls.getByRole('button').count(), 16);
      for (const pose of poses) {
        await controls.locator(`[data-state-button="${pose}"]`).click();
        const avatar = portrait(this, name);
        const art = avatar.locator('.assistant-character__art');
        const style = await art.evaluate(node => {
          const css = getComputedStyle(node);
          return { sheet: css.backgroundImage, position: css.backgroundPosition, animation: css.animationName };
        });
        assert.equal(await avatar.getAttribute('data-avatar-pose'), pose);
        this.avatarEvidence.push({ name, pose, theme, style, label: await avatar.getAttribute('aria-label') });
      }
    }
  }
});

Then('every pose has loaded artwork and a meaningful accessible name', async function () {
  assert.equal(this.avatarEvidence.length, 64);
  for (const item of this.avatarEvidence) {
    assert.match(item.label, new RegExp(`${item.name}.*${item.pose}`, 'i'));
    assert.ok(item.style.sheet.includes(`avatar-${item.theme}.png`), item.style.sheet);
  }
  for (const theme of ['light', 'dark']) {
    const response = await this.page.request.get(new URL(`/assistant/avatar-${theme}.png`, this.page.url()).href);
    assert.equal(response.status(), 200);
    assert.match(response.headers()['content-type'], /image\/png/);
    assert.ok((await response.body()).length > 1000);
  }
  for (const name of ['Symbi', 'Symbi Reflex']) {
    const positions = new Set(this.avatarEvidence.filter(item => item.name === name).map(item => item.style.position));
    assert.equal(positions.size, 16);
  }
  assert.deepEqual(this.pageErrors, []);
});

Then("changing Symbi Reflex's activity preserves Symbi's activity", async function () {
  await this.page.getByRole('group', { name: 'Preview Symbi animation' }).getByRole('button', { name: 'Writing', exact: true }).click();
  await this.page.getByRole('group', { name: 'Preview Symbi Reflex animation' }).getByRole('button', { name: 'Organizing', exact: true }).click();
  assert.equal(await portrait(this, 'Symbi').getAttribute('data-avatar-pose'), 'writing');
  assert.equal(await portrait(this, 'Symbi Reflex').getAttribute('data-avatar-pose'), 'organizing');
});

When('I choose the app sizes and reduce motion', async function () {
  for (const size of [56, 36, 28]) {
    await this.page.getByLabel('Portrait size').selectOption(String(size));
    for (const name of ['Symbi', 'Symbi Reflex']) {
      const box = await portrait(this, name).boundingBox();
      assert.equal(box.width, size);
      assert.equal(box.height, size);
    }
  }
  assert.ok((await motion(this)).some(name => name !== 'none'));
  await this.page.getByRole('button', { name: 'Reduce motion', exact: true }).click();
});

Then('both portraits use the chosen size and all avatar motion stops', async function () {
  assert.equal(await this.page.getByLabel('Portrait size').inputValue(), '28');
  assert.ok((await motion(this)).every(name => name === 'none'));
  assert.deepEqual(this.pageErrors, []);
});

When('the browser requests reduced motion', async function () {
  await this.page.emulateMedia({ reducedMotion: 'reduce' });
});

Then('both assistants remain visible without animations', async function () {
  for (const name of ['Symbi', 'Symbi Reflex']) assert.equal(await portrait(this, name).isVisible(), true);
  assert.ok((await motion(this)).every(name => name === 'none'));
  assert.deepEqual(this.pageErrors, []);
});

When('I try the conversation mapping example', async function () {
  await this.page.getByRole('button', { name: 'Map the decision', exact: true }).click();
  await this.page.locator('#state-caption').getByText('Work completed', { exact: true }).waitFor();
});

Then('the example shows its map and completion while Symbi Reflex stays at rest', async function () {
  assert.equal(await this.page.locator('#map-preview').isVisible(), true);
  assert.equal(await portrait(this, 'Symbi').getAttribute('data-avatar-pose'), 'done');
  assert.equal(await portrait(this, 'Symbi Reflex').getAttribute('data-avatar-pose'), 'resting');
  assert.deepEqual(this.pageErrors, []);
});

When('I interrupt each assistant with pause cancellation error and disconnection', async function () {
  this.avatarInterruptions = [];
  for (const name of ['Symbi', 'Symbi Reflex']) {
    const controls = this.page.getByRole('group', { name: `Preview ${name} interruption` });
    for (const state of ['paused', 'cancelled', 'error', 'unavailable']) {
      await this.page.getByRole('group', { name: `Preview ${name} animation` }).getByRole('button', { name: 'Done', exact: true }).click();
      await controls.locator(`[data-terminal-state="${state}"]`).click();
      const avatar = portrait(this, name);
      this.avatarInterruptions.push({ state: await avatar.getAttribute('data-avatar-state'),
        pose: await avatar.getAttribute('data-avatar-pose'),
        artAnimation: await avatar.locator('.assistant-character__art').evaluate(node => getComputedStyle(node).animationName),
        caption: await this.page.locator(name === 'Symbi' ? '#state-caption' : '#jev-state-caption').textContent(),
        animations: await avatar.evaluate(node => [node, ...node.querySelectorAll('*')].flatMap(element =>
          [null, '::before', '::after'].map(pseudo => getComputedStyle(element, pseudo).animationName))) });
    }
  }
});

Then('interrupted companions keep calm idle life without showing done', function () {
  assert.equal(this.avatarInterruptions.length, 8);
  for (const item of this.avatarInterruptions) {
    assert.notEqual(item.state, 'done');
    assert.notEqual(item.pose, 'done');
    assert.equal(item.artAnimation, 'assistant-breathe');
    assert.ok(item.animations.every(animation => !/celebrate|settle/.test(animation)));
    assert.ok(item.caption.length > 0);
    assert.notEqual(item.caption, 'Work completed');
  }
  assert.deepEqual(this.pageErrors, []);
});

When('I observe resting avatars at their default app size', async function () {
  assert.equal(await this.page.getByLabel('Portrait size').inputValue(), '56');
  for (const name of ['Symbi', 'Symbi Reflex']) {
    const avatar = portrait(this, name);
    const box = await avatar.boundingBox();
    assert.equal(box.width, 56);
    assert.equal(box.height, 56);
    assert.equal(await avatar.getAttribute('data-avatar-pose'), 'resting');
  }
  this.idleLife = await this.page.locator('.avatar--hero .assistant-character__art').evaluateAll(async nodes => {
    const before = nodes.map(node => getComputedStyle(node).transform);
    await new Promise(resolve => setTimeout(resolve, 500));
    return nodes.map((node, index) => ({ before: before[index], after: getComputedStyle(node).transform,
      animation: getComputedStyle(node).animationName, iterations: getComputedStyle(node).animationIterationCount }));
  });
});

Then('both companions keep calmly moving while at rest', function () {
  assert.equal(this.idleLife.length, 2);
  for (const sample of this.idleLife) {
    assert.equal(sample.animation, 'assistant-breathe');
    assert.equal(sample.iterations, 'infinite');
    assert.notEqual(sample.before, sample.after);
  }
  assert.deepEqual(this.pageErrors, []);
});

Then('the conversation has one larger avatar in its header', async function () {
  assert.equal(await this.page.locator('.chat .assistant-character').count(), 1);
  const avatar = this.page.locator('.chat-header .assistant-character');
  assert.equal(await avatar.getAttribute('data-avatar-name'), 'Symbi');
  const box = await avatar.boundingBox();
  assert.equal(box.width, 56);
  assert.equal(box.height, 56);
  assert.equal(await this.page.locator('.symbi-message .assistant-character').count(), 0);
  assert.deepEqual(this.pageErrors, []);
});
