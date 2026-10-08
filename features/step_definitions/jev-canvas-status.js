import { strict as assert } from 'node:assert';
import { expect } from 'playwright/test';
import { When, Then } from '@cucumber/cucumber';

const runbook = '# Release runbook\n\n## Staged rollout\n\nBen owns the staged rollout.\n\n1. Verify the release checks.\n2. Deploy to a small cohort.\n3. Review error rates before expanding.\n4. Keep the rollback checkpoint ready.\n\n## Rollback\n\nStop the rollout if the release checks fail. Restore the previous build and record the incident.';

async function request(world, route, method = 'GET', body) {
  const response = await fetch(`${world.baseUrl}/api${route}`, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
function card(world, source) { return world.page.locator(`.react-flow__node-document[data-id="${source.id}"] .canvas-card`); }
function panel(world) { return world.page.getByRole('region', { name: 'Symbi Reflex organization', exact: true }); }
function stateRoute(world) { return `/workspaces/${world.reflexWorkspaceId}/jev/state`; }

When('I save two identical release runbooks through the ordinary API', async function () {
  this.jevRunbooks = [];
  for (const [index, title] of ['Release runbook', 'Release runbook copy'].entries()) {
    this.jevRunbooks.push(await request(this, `/canvases/${this.canvasId}/blocks`, 'POST', {
      title, kind: 'markdown', content: runbook, x: index * 330, y: 0, width: 300, height: 300,
    }));
  }
  assert.ok(this.jevRunbooks.every(source => !source.jevMutationId && !source.jevDuplicates?.length));
});

When('I observe the runbook cards with Reflex before automatic processing starts', async function () {
  await this.page.getByRole('tab', { name: 'Symbi Reflex', exact: true }).click();
  await panel(this).getByText('Waiting for a TypeSafe API key in Settings.', { exact: true }).waitFor();
  await panel(this).getByText('Automatic findings and saved results', { exact: true }).click();
  for (const source of this.jevRunbooks) await expect(card(this, source)).toBeVisible();
  this.jevBrowserWrites = [];
  this.page.on('request', outgoing => { if (outgoing.method() !== 'GET' && /\/jev\//.test(new URL(outgoing.url()).pathname)) this.jevBrowserWrites.push(outgoing.url()); });
  await this.page.evaluate(() => {
    window.observedJevChanges = [];
    const observe = () => {
      for (const marker of document.querySelectorAll('.canvas-card__jev-change')) {
        const id = marker.closest('.react-flow__node-document')?.getAttribute('data-id');
        if (id && !window.observedJevChanges.includes(id)) window.observedJevChanges.push(id);
      }
    };
    const observer = new MutationObserver(observe);
    observer.observe(document.body, { childList: true, subtree: true });
    window.jevStatusObserver = observer;
  });
});

Then('the untouched runbooks have no Reflex markers or duplicate badges', async function () {
  assert.equal(await this.page.locator('.canvas-card__jev-marker, .canvas-card__jev-change, .canvas-card__duplicate').count(), 0);
  assert.deepEqual(this.pageErrors, []);
});

When('I enable the acceptance provider through ordinary secret settings', async function () {
  await request(this, '/settings', 'PUT', { secrets: { TYPESAFE_API_KEY: 'acceptance-reflex-key' } });
});

Then('both mounted runbook cards briefly report a real applied Jev change', async function () {
  await this.page.waitForFunction(ids => ids.every(id => window.observedJevChanges.includes(id)), this.jevRunbooks.map(source => source.id), { timeout: 30000 });
  const state = await request(this, stateRoute(this));
  for (const source of this.jevRunbooks) assert.ok(state.receipts.some(receipt => receipt.automatic && receipt.state === 'applied'
    && receipt.sourcesAfter.some(snapshot => snapshot.blockId === source.id)), `Missing applied native receipt for ${source.title}`);
  assert.deepEqual(this.jevBrowserWrites, []);
});

Then('both runbooks show checked duplicate references and durable Reflex markers', async function () {
  for (const [index, source] of this.jevRunbooks.entries()) {
    const related = this.jevRunbooks[1 - index];
    await expect(card(this, source).getByLabel('Organized by Reflex', { exact: true })).toBeVisible();
    await expect(card(this, source).getByLabel('Organized by Reflex', { exact: true })).toHaveText('Reflex did it');
    await expect(card(this, source).getByRole('button', { name: `Possible duplicate: ${related.title}`, exact: true })).toBeVisible({ timeout: 30000 });
  }
  await expect.poll(async () => {
    const state = await request(this, stateRoute(this));
    return state.jobs.every(job => !['queued', 'running'].includes(job.state));
  }, { timeout: 30000 }).toBe(true);
  this.jevStatusState = await request(this, stateRoute(this));
  this.jevStatusCanvas = await request(this, `/canvases/${this.canvasId}`);
  for (const [index, source] of this.jevRunbooks.entries()) {
    const saved = this.jevStatusCanvas.blocks.find(block => block.id === source.id);
    assert.equal(saved.content, runbook); assert.ok(saved.jevMutationId);
    assert.ok(saved.jevDuplicates.some(related => related.blockId === this.jevRunbooks[1 - index].id
      && this.jevStatusState.proposals.some(proposal => proposal.id === related.findingId && proposal.action === 'flag_duplicate')));
  }
  assert.deepEqual(this.pageErrors, []);
});

Then('saved Reflex results identify Reflex and their recorded time', async function () {
  await panel(this).getByText(/^Saved activity · \d+ results$/).click();
  const receipt = panel(this).locator('[data-receipt-id]').first(); await receipt.waitFor();
  const id = await receipt.getAttribute('data-receipt-id');
  const saved = this.jevStatusState.receipts.find(item => item.id === id);
  assert.ok(saved?.automatic); assert.equal(await receipt.locator('.jev-saved-attribution span').innerText(), 'Reflex');
  assert.equal(await receipt.locator('time').getAttribute('datetime'), saved.createdAt);
  assert.ok((await receipt.locator('time').innerText()).length > 0);
  await this.page.locator('.canvas-group__heading button').first().click();
  for (const source of this.jevRunbooks) await expect(card(this, source).locator('.canvas-card__body')).toBeVisible();
  await receipt.locator('.jev-saved-attribution').scrollIntoViewIfNeeded();
  await this.page.screenshot({ path: '/tmp/symbiknow-jev-canvas.png' });
  assert.deepEqual(this.pageErrors, []);
});

When('I reload the automatically organized runbook canvas', async function () {
  await this.page.evaluate(() => window.jevStatusObserver.disconnect());
  await this.page.reload({ waitUntil: 'networkidle' }); await this.page.locator('.canvas-surface').waitFor();
});

Then('the saved runbooks retain their source text provenance and duplicate badges', async function () {
  const canvas = await request(this, `/canvases/${this.canvasId}`);
  for (const [index, source] of this.jevRunbooks.entries()) {
    const saved = canvas.blocks.find(block => block.id === source.id);
    const before = this.jevStatusCanvas.blocks.find(block => block.id === source.id);
    assert.equal(saved.content, runbook); assert.equal(saved.jevMutationId, before.jevMutationId);
    assert.deepEqual(saved.jevDuplicates, before.jevDuplicates);
    await expect(card(this, source).getByLabel('Organized by Reflex', { exact: true })).toBeVisible();
    await expect(card(this, source).getByRole('button', { name: `Possible duplicate: ${this.jevRunbooks[1 - index].title}`, exact: true })).toBeVisible();
  }
  assert.equal(await this.page.locator('.canvas-card__jev-change').count(), 0, 'Reloading saved provenance should not announce a new mutation');
  assert.deepEqual(this.pageErrors, []);
});

When('I open the related runbook from its duplicate badge', async function () {
  await card(this, this.jevRunbooks[0]).getByRole('button', { name: `Possible duplicate: ${this.jevRunbooks[1].title}`, exact: true }).click();
});

Then('the exact related document opens without browser errors', async function () {
  const related = this.jevRunbooks[1];
  const reader = this.page.getByRole('dialog', { name: `${related.title} full page`, exact: true });
  await expect(reader).toBeVisible();
  await expect(reader.locator('.page-reader__content')).toContainText('Keep the rollback checkpoint ready.');
  assert.equal(new URL(this.page.url()).searchParams.get('doc'), related.id);
  assert.deepEqual(this.pageErrors, []);
  assert.deepEqual(this.jevBrowserWrites, []);
});
