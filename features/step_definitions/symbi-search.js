import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Given, When, Then } from '@cucumber/cucumber';

const runbook = '# Rollback runbook\n## Restore\nTo restore the previous deployment, redeploy the last good release.\n'
  + '## Verify\nCheck service health after the deployment is restored.';
const brandGuide = '# Brand guide\n## Colors\nAgent Blue is the primary accent color.';

async function api(world, route, { method = 'GET', body, token } = {}) {
  const response = await fetch(world.baseUrl + '/api' + route, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}

async function searchRequests(world) {
  const lines = (await readFile(join(world.dataDir, 'reflex-provider-requests.jsonl'), 'utf8').catch(() => '')).split('\n');
  return lines.filter(Boolean).map(line => JSON.parse(line)).filter(request => request.state?.documents);
}

Given('a search canvas with a saved provider key and an agent token', async function () {
  await api(this, '/settings', { method: 'PUT', body: { secrets: { TYPESAFE_API_KEY: 'acceptance-search-key' } } });
  await api(this, `/canvases/${this.canvasId}/jev/settings`, { method: 'PUT', body: { externalProcessing: true } });
  this.searchToken = (await api(this, '/mcp/tokens', { method: 'POST',
    body: { name: 'Search agent', access: 'read', allowedCanvasIds: [this.canvasId] } })).token;
});

When('a sectioned rollback runbook and an unrelated brand guide are saved through the ordinary API', async function () {
  this.runbook = await api(this, `/canvases/${this.canvasId}/blocks`, { method: 'POST', body: { title: 'Rollback runbook', content: runbook } });
  await api(this, `/canvases/${this.canvasId}/blocks`, { method: 'POST', body: { title: 'Brand guide', content: brandGuide } });
});

async function settledSearch(world, input) {
  const ask = () => api(world, '/symbi/ask', { method: 'POST', token: world.searchToken,
    body: { ...input, canvasId: world.canvasId } });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    world.searchAnswer = await ask();
    if (world.searchAnswer.coverage.pendingDocuments === 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Search coverage did not settle: ${JSON.stringify(world.searchAnswer.coverage)}`);
}

When('an agent asks Symbi {string} in combined mode', async function (question) {
  await settledSearch(this, { question, mode: 'combined' });
});

When('an agent asks Symbi about restoring deployment with an empty document selection', async function () {
  await settledSearch(this, { question: 'how do I restore the previous deployment', mode: 'semantic', documentIds: [] });
});

Then('local Symbi search checks permitted documents and finds the rollback runbook without a provider request', async function () {
  assert.ok(this.searchAnswer.coverage.checkedDocuments > 0, JSON.stringify(this.searchAnswer));
  assert.ok(this.searchAnswer.matches.some(match => match.blockId === this.runbook.id), JSON.stringify(this.searchAnswer));
  assert.ok(this.searchAnswer.matches.every(match => match.canvasId === this.canvasId));
  assert.deepEqual(await searchRequests(this), []);
});

Then('Symbi shows the rollback runbook first with the snippets Jev judged', async function () {
  const [first] = this.searchAnswer.matches;
  assert.equal(first?.blockId, this.runbook.id, JSON.stringify(this.searchAnswer));
  assert.equal(first.reason, 'Provider-validated source evidence');
  const [judged] = await searchRequests(this);
  const document = judged.state.documents.find(item => item.title === 'Rollback runbook');
  assert.deepEqual(document.sections, ['Restore', 'Verify']);
  assert.deepEqual(first.passages.map(passage => passage.excerpt.replace(/\s+/g, ' ').trim()), document.evidence);
});

Then('one provider request judged the candidates with a rank and a gate question', async function () {
  const requests = await searchRequests(this);
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0].questions), ['rank', 'gate']);
  assert.equal(this.searchAnswer.providerUsage.questions, 2);
});

Then('Symbi reports that nothing answers the question', async function () {
  assert.deepEqual(this.searchAnswer.matches, []);
  const requests = await searchRequests(this);
  assert.equal(requests.at(-1)?.state.question, 'is there an ipad deployment', 'Jev must judge the keyword candidates');
  assert.equal(this.searchAnswer.providerUsage.requests, 1);
});
