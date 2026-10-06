import { strict as assert } from 'node:assert';
import { When, Then } from '@cucumber/cucumber';
import { tsImport } from 'tsx/esm/api';
import path from 'node:path';

const { documentReviewState } = await tsImport('../../shared/document-state.ts', import.meta.url);
const { DocumentVersions } = await tsImport('../../server/version-control.ts', import.meta.url);
const { CanvasStore } = await tsImport('../../server/storage.ts', import.meta.url);

async function api(world, route, method = 'GET', body) {
  const response = await fetch(world.baseUrl + '/api' + route, { method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}

When('I use the compact navigation to create a workspace and canvas', async function () {
  await this.page.setViewportSize({ width: 390, height: 844 });
  const workspace = this.page.getByRole('button', { name: 'New workspace', exact: true });
  const canvas = this.page.getByRole('button', { name: 'New canvas', exact: true });
  assert.equal(await workspace.isVisible(), true);
  assert.equal(await canvas.isVisible(), true);
  await workspace.click();
  const dialog = this.page.getByRole('dialog', { name: 'Create new' });
  await dialog.getByLabel('Workspace name').fill('Compact team');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await canvas.click();
  await dialog.getByLabel('Canvas name').fill('Compact notes');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await this.page.getByRole('heading', { name: 'Compact notes', exact: true }).waitFor();
});

Then('the compact navigation creations survive reload', async function () {
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.getByRole('heading', { name: 'Compact notes', exact: true }).waitFor();
  const team = (await api(this, '/workspaces')).find(workspace => workspace.name === 'Compact team');
  assert.ok(team?.canvases.some(canvas => canvas.name === 'Compact notes'));
  assert.deepEqual(this.pageErrors, []);
  await this.page.screenshot({ path: '.quality/compact-navigation.png' });
});

When('I move a document referenced by a third canvas', async function () {
  const source = await api(this, '/canvases/' + this.canvasId);
  const target = await api(this, '/workspaces/' + source.workspaceId + '/canvases', 'POST', { name: 'Move destination' });
  const third = await api(this, '/workspaces/' + source.workspaceId + '/canvases', 'POST', { name: 'Move references' });
  const block = source.blocks[0];
  const reference = await api(this, '/canvases/' + third.id + '/blocks', 'POST', { title: 'Moved reference', content: '# Reference' });
  await api(this, '/canvases/' + third.id + '/blocks/' + reference.id, 'PUT', {
    crossLinks: [{ canvasId: source.id, blockId: block.id, relation: 'related' }],
  });
  await api(this, '/canvases/' + source.id + '/blocks/' + block.id + '/move', 'POST', { targetCanvasId: target.id });
  this.documentMove = { source: source.id, target: target.id, third: third.id, block: block.id, reference: reference.id };
});

Then('reloading all affected canvases preserves the moved reference', async function () {
  const move = this.documentMove;
  const source = await api(this, '/canvases/' + move.source);
  const target = await api(this, '/canvases/' + move.target);
  const third = await api(this, '/canvases/' + move.third);
  assert.equal(source.blocks.some(block => block.id === move.block), false);
  assert.equal(target.blocks.some(block => block.id === move.block), true);
  assert.deepEqual(third.blocks.find(block => block.id === move.reference).crossLinks,
    [{ canvasId: move.target, blockId: move.block, relation: 'related' }]);
});

async function reviewedWrite(world, document, body, method = 'DELETE') {
  const response = await fetch(world.baseUrl + `/api/canvases/${world.canvasId}/blocks/${document.id}`, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedDocumentState: documentReviewState(document),
      expectedSavedCrossLinks: JSON.stringify(document.crossLinks ?? []), ...body }),
  });
  return { status: response.status, body: await response.json() };
}

When('I review a new document before a later human edit and citation', async function () {
  const route = '/canvases/' + this.canvasId;
  const original = await api(this, route + '/blocks', 'POST', { title: 'Agent evidence for review', content: '# Agent evidence\nKeep reviewed source.' });
  const changed = await api(this, route + '/blocks/' + original.id, 'PUT', { tags: ['human-reviewed'], title: 'Human reviewed evidence' });
  const canvas = await api(this, route);
  const other = await api(this, '/workspaces/' + canvas.workspaceId + '/canvases', 'POST', { name: 'Citing canvas' });
  const source = await api(this, '/canvases/' + other.id + '/blocks', 'POST', { title: 'Saved citation', content: '# Saved citation' });
  await api(this, '/canvases/' + other.id + '/blocks/' + source.id, 'PUT', { crossLinks: [{ canvasId: this.canvasId, blockId: original.id }] });
  this.reviewedCreation = { original, changed, other: other.id, source: source.id, canvasName: canvas.name };
});

Then('reviewed deletion refuses the later edit and saved citation', async function () {
  const value = this.reviewedCreation;
  const stale = await reviewedWrite(this, value.original, { requireUnreferenced: true });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /changed since review/);
  const referenced = await reviewedWrite(this, value.changed, { requireUnreferenced: true });
  assert.equal(referenced.status, 409); assert.match(referenced.body.error, /cross-canvas reference/);
  assert.deepEqual((await api(this, '/canvases/' + this.canvasId)).blocks.find(block => block.id === value.original.id), value.changed);
  const history = await api(this, `/canvases/${this.canvasId}/blocks/${value.original.id}/versions`);
  assert.equal(history.commits.some(commit => commit.message.startsWith('Delete ')), false);
});

When('I deliberately remove the citation and review the current document', async function () {
  const value = this.reviewedCreation;
  await api(this, `/canvases/${value.other}/blocks/${value.source}`, 'PUT', { crossLinks: [] });
  const current = (await api(this, '/canvases/' + this.canvasId)).blocks.find(block => block.id === value.original.id);
  assert.equal((await reviewedWrite(this, current, { requireUnreferenced: true })).status, 200);
});

Then('the reviewed deletion survives reload and retains document history', async function () {
  await this.page.reload({ waitUntil: 'networkidle' }); await this.page.locator('.canvas-surface').waitFor();
  const value = this.reviewedCreation;
  assert.equal((await api(this, '/canvases/' + this.canvasId)).blocks.some(block => block.id === value.original.id), false);
  assert.equal((await api(this, '/canvases/' + value.other)).blocks.find(block => block.id === value.source).crossLinks, undefined);
  const history = await new DocumentVersions(path.join(this.dataDir, '.versions', value.original.id)).status();
  assert.equal(history.commits[0].message, `Delete ${value.changed.title} from canvas ${value.canvasName}`);
  assert.deepEqual(this.pageErrors, []);
});

When('a human updates metadata after I review an agent document edit', async function () {
  const route = '/canvases/' + this.canvasId + '/blocks';
  const before = await api(this, route, 'POST', { title: 'Reviewed edit', content: '# Original reviewed source' });
  const after = await api(this, route + '/' + before.id, 'PUT', { content: '# Agent source edit' });
  const human = await api(this, route + '/' + before.id, 'PUT', { tags: ['human-reviewed'], reviewer: 'Human owner' });
  this.reviewedEdit = { before, after, human };
});

Then('restoring the old reviewed edit refuses to overwrite the human metadata', async function () {
  const { before, after, human } = this.reviewedEdit;
  const response = await reviewedWrite(this, after, { expectedContentHash: after.contentHash, content: before.content, tags: before.tags ?? [] }, 'PUT');
  assert.equal(response.status, 409); assert.match(response.body.error, /changed since review/);
  assert.deepEqual((await api(this, '/canvases/' + this.canvasId)).blocks.find(block => block.id === before.id), human);
});

When('I review the current document before restoring its source', async function () {
  const { before, human } = this.reviewedEdit;
  const response = await reviewedWrite(this, human, { expectedContentHash: human.contentHash, content: before.content, message: 'Restore reviewed source' }, 'PUT');
  assert.equal(response.status, 200);
});

Then('the restored source and human metadata survive reload', async function () {
  await this.page.reload({ waitUntil: 'networkidle' }); await this.page.locator('.canvas-surface').waitFor();
  const { before, human } = this.reviewedEdit;
  const document = (await api(this, '/canvases/' + this.canvasId)).blocks.find(block => block.id === before.id);
  assert.equal(document.content, before.content); assert.deepEqual(document.tags, human.tags); assert.equal(document.reviewer, human.reviewer);
  const history = await api(this, `/canvases/${this.canvasId}/blocks/${before.id}/versions`);
  assert.equal(history.commits[0].message, 'Restore reviewed source');
  assert.deepEqual(this.pageErrors, []);
});

When('I reopen research with valid answers and damaged saved entries', async function () {
  const canvas = await api(this, '/canvases/' + this.canvasId); const block = canvas.blocks[0];
  const source = { canvasId: canvas.id, canvasName: canvas.name, blockId: block.id, title: block.title,
    excerpt: block.content.slice(0, 120), relevance: 1, contentHash: block.contentHash };
  const turn = { id: 1, query: 'Recover reviewed evidence', answer: '# Recovered answer\nPreserve this reviewed finding.', sources: [source], status: 'working' };
  const manual = { id: 'manual', turnId: 1, type: 'text', title: 'Recovered manual note', content: 'Preserve this human note.', markdown: '', sources: [], x: 450, y: 0, width: 640, height: 460 };
  this.recoveredResearch = { original: canvas, source, turn, manual };
  await this.page.evaluate(snapshot => localStorage.setItem('symbiknow:research-session', JSON.stringify(snapshot)), {
    turns: [turn, null, { ...turn, id: 2, sources: [null] }], layout: 'mindmap', edits: {
      added: [manual, null], changed: {}, deleted: [], addedEdges: [], deletedEdges: [],
    },
  });
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.getByRole('button', { name: 'Open research canvas', exact: true }).click();
});

Then('the recovered research retains its answer and manual note', async function () {
  const board = this.page.getByRole('region', { name: 'Research canvas' });
  await board.getByText('2 documents · 1 cited source', { exact: false }).waitFor();
  const saved = await this.page.evaluate(() => JSON.parse(localStorage.getItem('symbiknow:research-session')));
  assert.deepEqual(saved.turns, [{ ...this.recoveredResearch.turn, status: 'stopped' }]);
  assert.deepEqual(saved.edits.added, [this.recoveredResearch.manual]);
  assert.deepEqual(this.pageErrors, []);
});

When('I save the recovered research as files', async function () {
  const board = this.page.getByRole('region', { name: 'Research canvas' });
  await board.getByRole('button', { name: 'Save canvas', exact: true }).click();
  await board.getByText(/Saved as Research/u).waitFor();
  this.recoveredResearch.saved = (await api(this, '/workspaces')).flatMap(workspace => workspace.canvases)
    .find(canvas => canvas.name === 'Research — Recover reviewed evidence');
  assert.ok(this.recoveredResearch.saved);
});

Then('recovered answers and their citations survive reload', async function () {
  await this.page.reload({ waitUntil: 'networkidle' }); await this.page.locator('.canvas-surface').waitFor();
  const fresh = new CanvasStore(this.dataDir); await fresh.init();
  const saved = await fresh.getCanvas(this.recoveredResearch.saved.id, true);
  assert.equal(saved.blocks.length, 2);
  const answer = saved.blocks.find(block => block.title === 'Recovered answer');
  assert.ok(answer.content.includes('Preserve this reviewed finding.'));
  assert.deepEqual(answer.crossLinks, [{ canvasId: this.recoveredResearch.source.canvasId, blockId: this.recoveredResearch.source.blockId, relation: 'related' }]);
  const manual = saved.blocks.find(block => block.title === 'Recovered manual note');
  assert.ok(manual.content.includes('Preserve this human note.'));
  assert.equal(manual.width, this.recoveredResearch.manual.width);
  assert.equal(manual.height, this.recoveredResearch.manual.height);
  assert.deepEqual(JSON.parse(JSON.stringify(await fresh.getCanvas(this.canvasId, true))), this.recoveredResearch.original);
  assert.deepEqual(await api(this, '/canvases/' + this.canvasId), this.recoveredResearch.original);
  assert.deepEqual(this.pageErrors, []);
});

When('I prepare two saved documents for view history', async function () {
  const source = await api(this, '/canvases/' + this.canvasId);
  const canvas = await api(this, `/workspaces/${source.workspaceId}/canvases`, 'POST', { name: 'Saved document views' });
  let first = await api(this, `/canvases/${canvas.id}/blocks`, 'POST', { title: 'First view evidence', content: '# First view\n- [ ] Keep selection after saving', x: 100, y: 100 });
  let second = await api(this, `/canvases/${canvas.id}/blocks`, 'POST', { title: 'Second view evidence', content: '# Second view\nKeep this source unchanged.', x: 650, y: 100 });
  first = await api(this, `/canvases/${canvas.id}/blocks/${first.id}`, 'PUT', { width: 240, height: 220 });
  second = await api(this, `/canvases/${canvas.id}/blocks/${second.id}`, 'PUT', { x: 400, width: 240, height: 220 });
  this.canvasId = canvas.id;
  this.viewHistory = { canvas, first, second, before: await api(this, '/canvases/' + canvas.id) };
});

function viewHistoryCard(world, block) {
  return world.page.locator(`.react-flow__node[data-id="${block.id}"] .canvas-card`);
}

async function viewHistoryCheckbox(world, block) {
  const selector = `.react-flow__node[data-id="${block.id}"] .canvas-card input[type="checkbox"]`;
  await world.page.waitForFunction(selector => {
    const checkbox = document.querySelector(selector);
    if (!checkbox) return false;
    const bounds = checkbox.getBoundingClientRect();
    const stage = checkbox.closest('.canvas-flow-stage')?.getBoundingClientRect();
    const x = bounds.x + bounds.width / 2; const y = bounds.y + bounds.height / 2;
    return bounds.width > 0 && bounds.height > 0 && stage && x >= stage.left && x <= stage.right
      && y >= stage.top && y <= stage.bottom && document.elementFromPoint(x, y) === checkbox;
  }, selector, { timeout: 10_000 });
  return world.page.locator(selector);
}

async function showViewHistoryDocument(world, block) {
  await world.page.getByRole('button', { name: 'Search documents', exact: true }).click();
  await world.page.getByPlaceholder('Search every Markdown file…').fill(block.title);
  await world.page.getByRole('button', { name: `Show ${block.title} on canvas`, exact: true }).click();
  await world.page.locator(`.react-flow__node[data-id="${block.id}"] .canvas-card.is-selected`).waitFor();
  await viewHistoryCard(world, block).locator('.canvas-card__body').waitFor();
  await world.page.getByRole('button', { name: 'Close search', exact: true }).click();
  await world.page.getByRole('dialog', { name: 'Search documents', exact: true }).waitFor({ state: 'hidden' });
  await world.page.waitForLoadState('networkidle');
}

Then('removed canvas controls and floating navigation are absent', async function () {
  for (const name of ['Show group list', 'Group documents', 'Arrange by connections', 'Back to previous canvas view', 'Forward to next canvas view', 'Bookmarks and recently viewed', 'Hide header', 'Show header']) {
    assert.equal(await this.page.getByRole('button', { name, exact: true }).count(), 0);
  }
  assert.equal(await this.page.getByRole('tab', { name: 'Tasks', exact: true }).count(), 0);
  assert.equal(await this.page.locator('.canvas-navigation').count(), 0);
  assert.equal(await this.page.getByRole('button', { name: 'Browse groups', exact: true }).count(), 1);
  assert.deepEqual(this.pageErrors, []);
});

When('I select the first document after viewing another document', async function () {
  const value = this.viewHistory;
  await showViewHistoryDocument(this, value.first);
  await showViewHistoryDocument(this, value.second);
  await showViewHistoryDocument(this, value.first);
  await this.page.locator(`.react-flow__node[data-id="${value.first.id}"] .canvas-card.is-selected`).waitFor();
  assert.equal(await this.page.locator(`.react-flow__node[data-id="${value.second.id}"] .canvas-card.is-selected`).count(), 0);
});

Then('the selected document remains selected after saving its checkbox', async function () {
  const value = this.viewHistory;
  const checkbox = await viewHistoryCheckbox(this, value.first);
  await checkbox.waitFor(); assert.equal(await checkbox.isChecked(), false);
  const savedResponse = this.page.waitForResponse(response => response.request().method() === 'PUT'
    && response.url().endsWith(`/canvases/${this.canvasId}/blocks/${value.first.id}`));
  const outcomes = await Promise.allSettled([savedResponse, checkbox.check({ timeout: 10_000 })]);
  if (outcomes[1].status === 'rejected') {
    await this.page.screenshot({ path: '/tmp/symbiknow-navigation-checkbox.png' });
    throw outcomes[1].reason;
  }
  if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
  const response = outcomes[0].value;
  assert.equal(response.status(), 200, await response.text());
  await this.page.waitForLoadState('networkidle');
  assert.equal(await this.page.locator(`.react-flow__node[data-id="${value.first.id}"] .canvas-card.is-selected`).count(), 1);
  value.saved = await api(this, '/canvases/' + this.canvasId);
  const expected = JSON.parse(JSON.stringify(value.before));
  const changed = expected.blocks.find(block => block.id === value.first.id);
  const actual = value.saved.blocks.find(block => block.id === value.first.id);
  assert.equal(actual.content, changed.content.replace('- [ ]', '- [x]'));
  assert.equal(actual.incarnation, changed.incarnation);
  assert.equal(actual.sourceGeneration, changed.sourceGeneration + 1);
  assert.equal(actual.metadataRevision, changed.metadataRevision + 1);
  assert.notEqual(actual.contentHash, changed.contentHash);
  changed.content = actual.content; changed.contentHash = actual.contentHash;
  changed.sourceGeneration = actual.sourceGeneration; changed.metadataRevision = actual.metadataRevision;
  assert.deepEqual(value.saved, expected);
  const history = await api(this, `/canvases/${this.canvasId}/blocks/${value.first.id}/versions`);
  assert.ok(history.commits.length >= 2);
  assert.deepEqual(this.pageErrors, []);
});

When('I close the saved document inspector', async function () {
  await this.page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await this.page.locator('.canvas-inspector').waitFor({ state: 'hidden' });
  assert.equal(await this.page.locator('.react-flow__node .canvas-card.is-selected').count(), 0);
  assert.deepEqual(await api(this, '/canvases/' + this.canvasId), this.viewHistory.saved);
  assert.deepEqual(this.pageErrors, []);
});

Then('the saved checkbox survives browser reload and reselection', async function () {
  const value = this.viewHistory;
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.getByRole('heading', { name: value.canvas.name, exact: true }).waitFor();
  await showViewHistoryDocument(this, value.first);
  await this.page.locator(`.react-flow__node[data-id="${value.first.id}"] .canvas-card.is-selected`).waitFor();
  assert.equal(await (await viewHistoryCheckbox(this, value.first)).isChecked(), true);
  const restarted = new CanvasStore(this.dataDir); await restarted.init();
  assert.deepEqual(JSON.parse(JSON.stringify(await restarted.getCanvas(this.canvasId))), value.saved);
  assert.deepEqual(await api(this, '/canvases/' + this.canvasId), value.saved);
  assert.deepEqual(this.pageErrors, []);
});

async function renderedCamera(page) {
  const transform = await page.locator('.react-flow__viewport').evaluate(element => element.style.transform);
  const values = /translate\(([-\d.eE+]+)px,\s*([-\d.eE+]+)px\) scale\(([-\d.eE+]+)\)/u.exec(transform);
  assert.ok(values, `Missing rendered camera: ${transform}`);
  return { x: Number(values[1]), y: Number(values[2]), zoom: Number(values[3]) };
}

When('I return the camera through the zoom controls before its deferred end report', async function () {
  const canvas = await api(this, '/canvases/' + this.canvasId);
  const store = new CanvasStore(this.dataDir); await store.init();
  const histories = await Promise.all(canvas.blocks.map(block => store.documentHistory(canvas.id, block.id)));
  await this.page.waitForLoadState('networkidle');
  // The browser's public clock controls only platform scheduling. Installed
  // ReactFlow, D3 and the App retain their real input and end callbacks.
  await this.page.clock.install();
  await this.page.clock.pauseAt(new Date(Date.now() + 1000));
  const original = await renderedCamera(this.page);
  await this.page.getByRole('button', { name: 'Zoom In', exact: true }).press('Enter');
  assert.ok((await renderedCamera(this.page)).zoom > original.zoom);
  await this.page.clock.runFor(1); // Deliver In's normal zero-delay end event.
  await this.page.getByRole('button', { name: 'Zoom Out', exact: true }).press('Enter');
  const visible = await renderedCamera(this.page);
  assert.ok(Math.abs(visible.zoom - original.zoom) < 1e-10);
  assert.deepEqual(await api(this, '/canvases/' + canvas.id), canvas);
  this.deferredCamera = { canvas, histories, visible };
  await this.page.clock.resume();
});

Then('reloading after camera changes preserves documents and revision history', async function () {
  const value = this.deferredCamera;
  await this.page.reload({ waitUntil: 'networkidle' });
  await this.page.locator('.canvas-label h1').waitFor();
  assert.ok((await renderedCamera(this.page)).zoom > 0);
  const restarted = new CanvasStore(this.dataDir); await restarted.init();
  assert.deepEqual(JSON.parse(JSON.stringify(await restarted.getCanvas(value.canvas.id))), value.canvas);
  assert.deepEqual(await Promise.all(value.canvas.blocks.map(block => restarted.documentHistory(value.canvas.id, block.id))), value.histories);
  assert.deepEqual(this.pageErrors, []);
});
