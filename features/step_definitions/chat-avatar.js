import { strict as assert } from 'node:assert';
import { When, Then } from '@cucumber/cucumber';

function companion(world) {
  return world.page.locator('.chat-header > [data-avatar-name="Symbi"]');
}

async function assertSingleCompanion(world) {
  const panel = world.page.getByRole('complementary', { name: 'Symbi assistant' });
  assert.equal(await panel.locator('[data-avatar-name]').count(), 1);
  assert.equal(await companion(world).count(), 1);
  const box = await companion(world).boundingBox();
  assert.equal(box.width, 56);
  assert.equal(box.height, 56);
  assert.equal(await panel.locator('.ai-chat__welcome [data-avatar-name], .ai-chat__messages [data-avatar-name]').count(), 0);
  assert.deepEqual(world.pageErrors, []);
}

When('I configure the native avatar conversation', async function () {
  const response = await fetch(`${this.baseUrl}/api/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-4o-mini', apiKey: 'acceptance-chat-key' }),
  });
  assert.equal(response.status, 200);
});

When('I open the single companion chat', async function () {
  const panel = this.page.getByRole('complementary', { name: 'Symbi assistant' });
  if (!await panel.isVisible()) await this.page.getByRole('button', { name: /^Toggle Symbi$/ }).first().click();
  await this.page.getByRole('textbox', { name: 'Message Symbi' }).waitFor();
});

Then('the chat has one 56 pixel avatar in its header', async function () {
  await assertSingleCompanion(this);
  assert.equal(await companion(this).getAttribute('data-avatar-pose'), 'resting');
});

When('I complete two native chat answers', async function () {
  this.completedQuestions = ['Explain the release briefly', 'Explain the next step briefly'];
  for (const [index, question] of this.completedQuestions.entries()) {
    await this.page.getByRole('textbox', { name: 'Message Symbi' }).fill(question);
    const response = this.page.waitForResponse(value => new URL(value.url()).pathname === '/api/chat/stream');
    await this.page.getByRole('button', { name: 'Submit', exact: true }).click();
    assert.equal((await response).status(), 200);
    await this.page.locator('.ai-chat__answer').nth(index).getByText('Ready.', { exact: true }).waitFor();
    await this.page.getByRole('button', { name: 'Submit', exact: true }).waitFor();
    assert.equal(await companion(this).getAttribute('data-avatar-pose'), 'done');
    await assertSingleCompanion(this);
  }
});

Then('the conversation keeps one avatar and both answers', async function () {
  await assertSingleCompanion(this);
  assert.equal(await this.page.locator('.ai-chat__answer').count(), 2);
  for (const question of this.completedQuestions) {
    assert.equal(await this.page.getByText(question, { exact: true }).count(), 1);
  }
});

When('I reload the companion conversation and reduce motion', async function () {
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.getByRole('textbox', { name: 'Message Symbi' }).waitFor();
  await this.page.emulateMedia({ reducedMotion: 'reduce' });
});

Then('the single companion retains its artwork and respects reduced motion', async function () {
  await assertSingleCompanion(this);
  assert.equal(await this.page.locator('.ai-chat__answer').count(), 2);
  assert.equal(await companion(this).getAttribute('data-avatar-pose'), 'resting');
  for (const theme of ['dark', 'light']) {
    if (await this.page.locator('html').getAttribute('data-theme') !== theme) {
      await this.page.getByRole('button', { name: `Switch to ${theme} mode`, exact: true }).click();
    }
    const art = await companion(this).locator('.assistant-character__art').evaluate(node => {
      const style = getComputedStyle(node);
      return { image: style.backgroundImage, animation: style.animationName };
    });
    assert.ok(art.image.includes(`avatar-${theme}.png`));
    assert.equal(art.animation, 'none');
  }
  assert.deepEqual(this.pageErrors, []);
});
