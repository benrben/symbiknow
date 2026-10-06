import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp,rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import type { JevJob,JevProposal,JevReceipt,JevWorkspaceState } from '../shared/jev-types.js';
import type { CanvasBlock } from '../shared/types.js';
import { internalToken } from './auth.js';
import { createApiServer } from './index.js';
import type { JevQuestion } from './jev.js';
import { JevWorkspaceFiles } from './jev/workspace.js';
import { createProjectMcpServer } from './mcp.js';
import { CanvasStore } from './storage.js';
import { sourceSnapshot } from './jev/stamps.js';
import { readJevDraft, stageJevDraft } from './jev/drafts.js';

const opened: Array<{ server: Server; root: string }> = [];
beforeEach(() => {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', ''); vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
  vi.stubEnv('SYMBIKNOW_MCP_TOKEN', ''); vi.stubEnv('ALLTEAM_MCP_TOKEN', '');
  vi.stubEnv('TYPESAFE_API_KEY', '');
});
afterEach(async () => {
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
  vi.unstubAllEnvs();
});

async function fixture(fetcher?: typeof fetch, existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(path.join(tmpdir(), 'symbi-reflex-native-'));
  const server = await createApiServer({ dataDir: root, fetcher }); opened.push({ server, root });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native server address');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(base + '/api' + route,
    { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const state = () => request('/canvases/product-roadmap/jev/state').then(response => response.json()) as Promise<JevWorkspaceState>;
  return { root, base, request, state, server };
}
function provider() {
  return vi.fn<typeof fetch>(async (_url, options) => {
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer native-fixture-key');
    const { questions } = JSON.parse(String(options?.body)) as { questions: Record<string, JevQuestion> };
    const answers = Object.fromEntries(Object.entries(questions).map(([key, question]) => {
      if (question.type === 'noul') return [key, { type: 'noul', noul: ['addressesAi', 'unrelatedDeletion', 'unsupportedClaim', 'requirementConflict'].includes(key) ? 0.01 : 0.99 }];
      if (question.type === 'score') return [key, { type: 'score', score: 1, confidence: 1, probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, index === 1 ? 1 : 0])) }];
      const choices = Object.keys(question.criteria); const selected = choices.find(choice => !['none', 'unknown'].includes(choice))!;
      return [key, { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(choices.map(choice => [choice, choice === selected ? 1 : 0])) }];
    }));
    return Response.json({ answers });
  });
}
async function completed(state: () => Promise<JevWorkspaceState>, id: string) {
  let result: JevWorkspaceState = await state();
  for (let attempt = 0; attempt < 100 && ['queued', 'running'].includes(result.jobs.find(job => job.id === id)?.state ?? 'queued'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10)); result = await state();
  }
  expect(result.jobs.find(job => job.id === id)?.state, result.jobs.find(job => job.id === id)?.error).toBe('completed'); return result;
}

async function savedDocumentProposals(root: string, canvasId: string, blockIds: string[], patch: { tags: string[] } | { group: string }) {
  const store = new CanvasStore(root); await store.ensureJevStamps(canvasId);
  const canvas = await store.getCanvas(canvasId, true);
  const files = new JevWorkspaceFiles(root); const state = await files.read(canvas.workspaceId);
  const proposals: JevProposal[] = blockIds.map((id, index) => {
    const block = canvas.blocks.find(item => item.id === id)!; const source = sourceSnapshot(canvas.workspaceId, canvasId, block);
    const quote = block.content.split('\n')[0];
    return { id: `saved-native-${state.proposals.length + index}`, jobId: 'saved-agent-proposal', action: 'group' in patch ? 'file' : 'label',
      title: 'Saved source-grounded organization', explanation: 'Checked saved source passage supports the retained organization action.',
      mutation: { kind: 'document', canvasId, blockId: id, patch }, sources: [source],
      evidence: [{ source, start: 0, end: quote.length, quote }], state: 'pending', createdAt: new Date().toISOString() };
  });
  state.proposals.push(...proposals); await files.write(canvas.workspaceId, state); return proposals;
}

it('uses exact REST methods, validates bounded requests, and protects workspace approval from agent/display headers', async () => {
  const { request, state } = await fixture();
  expect(await state()).toMatchObject({ schemaVersion: 1, jobs: [], settings: { externalProcessing: true } });
  const cases: Array<[string, string, unknown, number]> = [
    ['unknown', 'GET', undefined, 404], ['settings', 'GET', undefined, 405], ['state', 'POST', {}, 405],
    ['actions', 'PUT', {}, 405], ['actions', 'POST', { action: 'profile', unexpected: true }, 400],
    ['actions', 'POST', { action: 'profile', blockIds: Array.from({ length: 21 }, () => 'roadmap-overview') }, 400],
    ['actions', 'POST', { action: 'profile', query: 'x'.repeat(4001) }, 400],
    ['actions', 'POST', { action: 'profile', options: { huge: 'x'.repeat(24_000) } }, 400],
    ['actions', 'POST', { action: 'set_headline' }, 400],
    ['actions', 'POST', { action: 'profile' }, 200],
  ];
  for (const [operation, method, body, status] of cases) expect((await request(`/canvases/product-roadmap/jev/${operation}`, method, body)).status).toBe(status);
  const scoped = await request('/workspaces/acme-team/jev/actions', 'POST', { action: 'profile', canvasId: 'product-roadmap', blockIds: ['roadmap-overview'] });
  expect(scoped.status).toBe(200);
  const job = await scoped.json() as JevJob;
  expect(job.request).toMatchObject({ action: 'profile', canvasId: 'product-roadmap', blockIds: ['roadmap-overview'] });
  const cancelled = await request(`/workspaces/acme-team/jev/jobs/${job.id}/cancel`, 'POST');
  expect(cancelled.status).toBe(200); expect(await cancelled.json()).toEqual({ ok: true });
  expect((await state()).jobs.find(item => item.id === job.id)?.state).toBe('cancelled');
  expect((await request('/canvases/product-roadmap/jev/settings', 'PUT', { externalProcessing: true }, { origin: 'https://attacker.example' })).status).toBe(403);
  expect((await request('/canvases/product-roadmap/jev/settings', 'PUT', { externalProcessing: true }, { authorization: `Bearer ${internalToken}`, 'x-symbiknow-actor': 'workspace-owner' })).status).toBe(403);
  expect((await request('/canvases/product-roadmap/jev/agent/proposals/forged/apply', 'POST', {}, { 'x-symbiknow-actor': 'workspace-owner' })).status).toBe(403);
  expect((await request('/canvases/product-roadmap/jev/metadata', 'PUT', { blockId: 'roadmap-overview', unknown: 'field' })).status).toBe(400);
  const pinned = await request('/canvases/product-roadmap/jev/metadata', 'PUT', { blockId: 'roadmap-overview', group: 'custom:pinned-manually', pins: ['group'], managed: ['tags'] });
  expect(pinned.status, JSON.stringify(await pinned.json())).toBe(200);
  const block = await request('/canvases/product-roadmap/blocks/roadmap-overview').then(response => response.json());
  expect(block).toMatchObject({ group: 'custom:pinned-manually', jevOwnership: { pins: ['group'], managed: ['tags'] } });
});

it('reads and cancels protected historic drafts through native owner HTTP without changing saved source bytes', async () => {
  const { request, root } = await fixture();
  const store = new CanvasStore(root); await store.ensureJevStamps('product-roadmap');
  const source = await store.getCanvasBlock('product-roadmap', 'roadmap-overview');
  const token = await store.createMcpToken('Historic draft author', 'propose', { allowedCanvasIds: ['product-roadmap'] });
  const identity = (await store.mcpTokenIdentity(token.token))!;
  const draft = await stageJevDraft(root, sourceSnapshot('acme-team', 'product-roadmap', source),
    { id: 'historic-edit', baseContent: source.content, proposedContent: source.content + '\nEarlier staged edit.', instruction: 'Earlier edit awaiting resolution' }, identity.id);
  const route = '/canvases/product-roadmap/jev/drafts/roadmap-overview';
  expect(await request(route).then(response => response.json())).toEqual(draft);
  const headers = { authorization: `Bearer ${token.token}` };
  expect(await request(route, 'GET', undefined, headers).then(response => response.json())).toEqual(draft);
  expect((await request(route, 'GET', undefined, { 'x-symbiknow-actor': identity.id })).status).toBe(200);
  expect((await request('/canvases/product-roadmap/jev/agent/drafts/roadmap-overview')).status).toBe(403);
  expect((await request(route + '/cancel', 'POST', { draftId: draft.id }, headers)).status).toBe(403);
  expect((await request(route + '/cancel', 'POST', { draftId: '' })).status).toBe(400);
  const cancelled = await request(route + '/cancel', 'POST', { draftId: draft.id });
  expect(cancelled.status).toBe(200); expect(await cancelled.json()).toEqual({ ok: true });
  expect(await readJevDraft(root, 'product-roadmap', source.id)).toEqual({ ...draft, state: 'cancelled' });
  expect(await new CanvasStore(root).getCanvasBlock('product-roadmap', source.id)).toEqual(source);
});

it('revises and dismisses a persisted retained proposal while requiring owner authority and preserving canonical metadata', async () => {
  const { request, root, state } = await fixture();
  const [proposal] = await savedDocumentProposals(root, 'product-roadmap', ['roadmap-overview'], { tags: ['Launch'] });
  const store = new CanvasStore(root); const source = await store.getCanvasBlock('product-roadmap', 'roadmap-overview');
  const mutation = { kind: 'document', canvasId: 'product-roadmap', blockId: source.id, patch: { tags: ['Owner checked launch'] } };
  const route = `/canvases/product-roadmap/jev/proposals/${proposal.id}`;
  expect((await request('/canvases/product-roadmap/jev/agent/proposals/' + proposal.id + '/revise', 'POST', { mutation })).status).toBe(403);
  const revised = await request(route + '/revise', 'POST', { mutation });
  expect(revised.status).toBe(200); expect(await revised.json()).toMatchObject({ id: proposal.id, state: 'pending', reviewerEdited: true, mutation });
  const dismissed = await request(route + '/dismiss', 'POST');
  expect(dismissed.status).toBe(200); expect(await dismissed.json()).toEqual({ ok: true });
  expect((await state()).proposals.find(item => item.id === proposal.id)).toMatchObject({ state: 'dismissed', reviewerEdited: true, mutation });
  expect(await new CanvasStore(root).getCanvasBlock('product-roadmap', source.id)).toEqual(source);
});

it('rejects ambiguous workspace mutations and unauthorized read views without changing saved knowledge', async () => {
  const { request, root, state } = await fixture();
  const sourceRoute = '/canvases/product-roadmap/blocks/roadmap-overview';
  const before = await request(sourceRoute).then(response => response.json()) as CanvasBlock;
  const invalid: Array<[string, string, unknown, number]> = [
    ['metadata', 'PUT', { blockId: before.id, headline: 'Ambiguous target' }, 400],
    [`drafts/${before.id}`, 'GET', undefined, 400],
    ['undo-parent', 'POST', { kind: 'created', after: before }, 400],
    ['commands', 'POST', { canvasId: 'product-roadmap', recipe: 'organize' }, 404],
    ['commands', 'POST', { canvasId: 'product-roadmap', recipe: 'unknown' }, 404],
  ];
  for (const [operation, method, body, status] of invalid) {
    expect((await request(`/workspaces/acme-team/jev/${operation}`, method, body)).status).toBe(status);
  }
  expect((await request('/canvases/product-roadmap/jev/commands', 'POST', { recipe: 'organize' })).status).toBe(404);
  expect(await request(`/canvases/product-roadmap/jev/drafts/${before.id}`).then(response => response.json())).toBeNull();
  expect(await request('/canvases/product-roadmap/jev/agent/state').then(response => response.json())).toEqual({ jobs: [], receipts: [] });
  expect((await request('/canvases/product-roadmap/jev/state', 'GET', undefined, { authorization: 'Bearer revoked-or-forged' })).status).toBe(401);
  const store = new CanvasStore(root);
  const token = await store.createMcpToken('Only job status', 'read', { allowedCanvasIds: ['product-roadmap'], tools: ['jev_job'] });
  const headers = { authorization: `Bearer ${token.token}` };
  const read = '/canvases/product-roadmap/jev/agent/state';
  expect((await request(read + '?view=unknown', 'GET', undefined, headers)).status).toBe(403);
  expect((await request(read + '?view=jev_activity', 'GET', undefined, headers)).status).toBe(403);
  const missing = await request(read + '?view=jev_job&jobId=missing', 'GET', undefined, headers);
  expect(missing.status).toBe(200); expect(await missing.json()).toBeNull();
  expect(await request(sourceRoute).then(response => response.json())).toEqual(before);
  expect(await state()).toMatchObject({ jobs: [], proposals: [], receipts: [] });
});

it('preserves authenticated reviewer sessions while rejecting a forged agent bearer even beside a valid session', async () => {
  const { request, base } = await fixture();
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'native-owner-session-key');
  const signedIn = await request('/session', 'POST', { token: 'native-owner-session-key' });
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, origin: base };
  const owner = await request('/canvases/product-roadmap/jev/state', 'GET', undefined, headers);
  expect(owner.status).toBe(200); expect(await owner.json()).toMatchObject({ canApprove: true, canConfigure: true });
  const forged = await request('/canvases/product-roadmap/jev/state', 'GET', undefined,
    { ...headers, authorization: 'Bearer forged-agent', 'x-symbiknow-actor': 'workspace-owner' });
  expect(forged.status).toBe(401); expect(await forged.json()).toEqual({ error: 'The agent token is no longer authorized' });
});

it('rejects stale saved evidence and applies and undoes exact retained label changes across restart', async () => {
  const first = await fixture();
  const [stale] = await savedDocumentProposals(first.root, 'product-roadmap', ['roadmap-overview'], { tags: ['Launch'] });
  const sourceRoute = '/canvases/product-roadmap/blocks/roadmap-overview';
  const source = await first.request(sourceRoute).then(response => response.json()) as CanvasBlock;
  await first.request(sourceRoute, 'PUT', { content: source.content + '\nA current launch requirement.' });
  expect((await first.request(`/canvases/product-roadmap/jev/proposals/${stale.id}/apply`, 'POST')).status).toBe(409);
  const [proposal] = await savedDocumentProposals(first.root, 'product-roadmap', ['roadmap-overview'], { tags: ['Launch'] });
  const original = await first.request(sourceRoute).then(response => response.json()) as CanvasBlock;
  const applied = await first.request(`/canvases/product-roadmap/jev/proposals/${proposal.id}/apply`, 'POST').then(response => response.json()) as JevReceipt;
  expect(applied.state, JSON.stringify(applied)).toBe('applied');
  const updated = await first.request(sourceRoute).then(response => response.json()) as CanvasBlock;
  expect(updated.tags).toEqual(['Launch']); expect(updated.contentHash).toBe(original.contentHash); expect(updated.content).toBe(original.content);
  first.server.closeAllConnections(); await new Promise<void>(resolve => first.server.close(() => resolve()));
  opened.splice(opened.findIndex(item => item.server === first.server), 1);
  const second = await fixture(undefined, first.root); expect((await second.state()).receipts.some(receipt => receipt.id === applied.id)).toBe(true);
  expect((await second.request(`/canvases/product-roadmap/jev/receipts/${applied.id}/undo`, 'POST')).status).toBe(200);
  const restored = await second.request(sourceRoute).then(response => response.json()) as CanvasBlock;
  expect(restored.tags).toBe(original.tags); expect(restored.content).toBe(original.content);
});

it('exposes native HTTP and stdio MCP request/read tools while rejecting approval, out-of-scope calls and revoked credentials', async () => {
  const remote = provider(); const { request, base, root, state } = await fixture(remote);
  await request('/canvases/product-roadmap/blocks/roadmap-overview', 'PUT', { tags: [] });
  const files = new JevWorkspaceFiles(root); const vocabulary = await files.read('acme-team');
  vocabulary.vocabulary.push({ id: 'launch-label', kind: 'label', name: 'Launch', definition: 'Launch plans', aliases: [], state: 'active', version: 1, members: [] });
  await files.write('acme-team', vocabulary);
  await request('/settings', 'PUT', { secrets: { TYPESAFE_API_KEY: 'native-fixture-key' } });
  expect((await request('/canvases/product-roadmap/jev/settings', 'PUT', { externalProcessing: true, modes: { label: 'auto' } })).status).toBe(200);
  const store = new CanvasStore(root);
  const created = await store.createMcpToken('Reflex proposer', 'propose', { allowedCanvasIds: ['product-roadmap'], tools: ['jev_propose', 'jev_job', 'brain_inbox'] });
  const client = new Client({ name: 'reflex-native-client', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${created.token}` } } });
  await client.connect(transport);
  try {
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['jev_propose', 'jev_job', 'brain_inbox']));
    const response = await client.callTool({ name: 'jev_propose', arguments: { canvasId: 'product-roadmap', action: 'label', blockIds: ['roadmap-overview'] } });
    expect(response.isError).not.toBe(true); const job = JSON.parse((response.content as Array<{ text: string }>)[0].text) as JevJob;
    await completed(state, job.id);
    expect((await client.callTool({ name: 'jev_job', arguments: { canvasId: 'product-roadmap', jobId: job.id } })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'brain_inbox', arguments: { canvasId: 'engineering' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'jev_resolve', arguments: { canvasId: 'product-roadmap', proposalId: 'anything' } })).isError).toBe(true);
    const inbox = await request('/canvases/product-roadmap/jev/agent/state?view=brain_inbox', 'GET', undefined, { authorization: `Bearer ${created.token}` }).then(response => response.json()) as JevProposal[];
    expect(inbox.length).toBeGreaterThan(0);
    expect((await request(`/canvases/product-roadmap/jev/proposals/${inbox[0].id}/apply`, 'POST', {}, { authorization: `Bearer ${created.token}`, 'x-symbiknow-actor': 'workspace-owner' })).status).toBe(403);
    await store.revokeMcpToken(created.settings.mcpTokens![0].id);
    expect((await request('/canvases/product-roadmap/jev/agent/state?view=brain_inbox', 'GET', undefined, { authorization: `Bearer ${created.token}` })).status).not.toBe(200);
  } finally { await client.close(); }
  const stdio = createProjectMcpServer(base + '/api', fetch, { legacyBrainTools: true }); const local = new Client({ name: 'stdio-agent', version: '1' });
  const [localSide, serverSide] = InMemoryTransport.createLinkedPair(); await Promise.all([stdio.connect(serverSide), local.connect(localSide)]);
  try { expect((await local.callTool({ name: 'jev_profile', arguments: { canvasId: 'product-roadmap' } })).isError).not.toBe(true); }
  finally { await local.close(); await stdio.close(); }
});

it('verifies the saved TypeSafe key without sending documents and denies agent connection probes', async () => {
  const remote = provider(); const { request } = await fixture(remote);
  expect((await request('/canvases/product-roadmap/jev/connection', 'POST')).status).toBe(400);
  await request('/settings', 'PUT', { secrets: { TYPESAFE_API_KEY: 'native-fixture-key' } });
  const checked = await request('/canvases/product-roadmap/jev/connection', 'POST');
  expect(checked.status).toBe(200); expect(await checked.json()).toMatchObject({ connected: true, provider: 'TypeSafe', documentsSent: 0 });
  const probes = remote.mock.calls.filter(call => JSON.parse(String(call[1]?.body)).state?.connectionProbe);
  expect(probes).toHaveLength(1);
  expect(JSON.parse(String(probes[0][1]?.body)).state).toEqual({ connectionProbe: true });
  expect((await request('/canvases/product-roadmap/jev/agent/connection', 'POST', {}, { 'x-symbiknow-actor': 'workspace-owner' })).status).toBe(403);
});

it('preserves human group names in browser reads while scoped native MCP omits mixed-canvas vocabulary names', async () => {
  const { request, base, root } = await fixture();
  const publicBlock = await request('/canvases/product-roadmap/blocks', 'POST', { title: 'Public delivery', content: '# Delivery', group: 'custom:topic_a' }).then(response => response.json());
  const mixedBlock = await request('/canvases/product-roadmap/blocks', 'POST', { title: 'Mixed delivery', content: '# Delivery', group: 'custom:topic_b' }).then(response => response.json());
  const privateCanvas = await request('/workspaces/acme-team/canvases', 'POST', { name: 'Private terms' }).then(response => response.json());
  const privateBlock = await request(`/canvases/${privateCanvas.id}/blocks`, 'POST', { title: 'Private source' }).then(response => response.json());
  const files = new JevWorkspaceFiles(root); const workspace = await files.read('acme-team');
  workspace.vocabulary = [
    { id: 'public-delivery', kind: 'group', name: 'מסירה', groupKey: 'custom:topic_a', definition: 'Public delivery', aliases: [], state: 'active', version: 1,
      members: [{ canvasId: 'product-roadmap', blockId: publicBlock.id }] },
    { id: 'mixed-delivery', kind: 'group', name: 'Confidential delivery name', groupKey: 'custom:topic_b', definition: 'Mixed delivery', aliases: [], state: 'active', version: 1,
      members: [{ canvasId: 'product-roadmap', blockId: mixedBlock.id }, { canvasId: privateCanvas.id, blockId: privateBlock.id }] },
  ];
  await files.write('acme-team', workspace);
  const ownerRead = await request('/canvases/product-roadmap'); const ownerTag = ownerRead.headers.get('etag')!;
  expect((await ownerRead.json()).groupLabels).toEqual({ 'custom:topic_a': 'מסירה', 'custom:topic_b': 'Confidential delivery name' });
  expect((await request('/canvases/product-roadmap?summary=1').then(response => response.json())).groupLabels).toEqual({ 'custom:topic_a': 'מסירה', 'custom:topic_b': 'Confidential delivery name' });
  const store = new CanvasStore(root); const created = await store.createMcpToken('Scoped names', 'read', { allowedCanvasIds: ['product-roadmap'], tools: ['read_canvas'] });
  const headers = { authorization: `Bearer ${created.token}`, 'if-none-match': ownerTag };
  const scopedRead = await request('/canvases/product-roadmap', 'GET', undefined, headers);
  expect(scopedRead.status).toBe(200); const scopedTag = scopedRead.headers.get('etag')!;
  expect(scopedTag).not.toBe(ownerTag); expect((await scopedRead.json()).groupLabels).toEqual({ 'custom:topic_a': 'מסירה' });
  expect((await request('/canvases/product-roadmap?summary=1', 'GET', undefined, headers).then(response => response.json())).groupLabels).toEqual({ 'custom:topic_a': 'מסירה' });
  expect((await request('/canvases/product-roadmap', 'GET', undefined, { ...headers, 'if-none-match': scopedTag })).status).toBe(304);
  expect((await request(`/canvases/${privateCanvas.id}`, 'GET', undefined, headers)).status).toBe(403);
  const client = new Client({ name: 'scoped-label-client', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers } }));
  try {
    const result = await client.callTool({ name: 'read_canvas', arguments: { canvasId: 'product-roadmap' } });
    expect(result.isError).not.toBe(true); expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).groupLabels).toEqual({ 'custom:topic_a': 'מסירה' });
    workspace.vocabulary[0].name = 'Delivery'; workspace.vocabulary[0].version += 1; await files.write('acme-team', workspace);
    const renamed = await request('/canvases/product-roadmap', 'GET', undefined, { ...headers, 'if-none-match': scopedTag });
    expect(renamed.status).toBe(200); expect(renamed.headers.get('etag')).not.toBe(scopedTag); expect((await renamed.json()).groupLabels).toEqual({ 'custom:topic_a': 'Delivery' });
    await store.revokeMcpToken(created.settings.mcpTokens![0].id);
    await expect(client.callTool({ name: 'read_canvas', arguments: { canvasId: 'product-roadmap' } })).rejects.toThrow('Missing or invalid MCP token');
    expect((await request('/canvases/product-roadmap', 'GET', undefined, headers)).status).toBe(401);
  } finally { await client.close(); }
});

it('protects saved legacy group cohorts through the owner API and refuses a stale member before saving any placement', async () => {
  const { request, root } = await fixture();
  const canvas = await request('/workspaces/acme-team/canvases', 'POST', { name: 'Grouped review' }).then(response => response.json());
  await request(`/canvases/${canvas.id}/blocks`, 'POST', { title: 'Reference', content: '# Release guide', group: 'custom:release/staged' });
  const members = await Promise.all(['First decision', 'Second decision'].map(title => request(`/canvases/${canvas.id}/blocks`, 'POST', { title, content: '# Release guide\nStaged rollout checkpoint.' }).then(response => response.json()))) as CanvasBlock[];
  async function cohort() {
    return savedDocumentProposals(root, canvas.id, members.map(member => member.id), { group: 'custom:release/staged' });
  }
  const first = await cohort(); expect(first).toHaveLength(2);
  await request(`/canvases/${canvas.id}/blocks/${members[1].id}`, 'PUT', { tags: ['manual correction'] });
  const stale = await request(`/canvases/${canvas.id}/jev/groups/approve`, 'POST', { groupKey: 'custom:release/staged', proposalIds: first.map(proposal => proposal.id) });
  expect(stale.status, await stale.text()).toBe(409);
  const unchanged = await request(`/canvases/${canvas.id}`).then(response => response.json());
  expect(unchanged.blocks.filter((block: CanvasBlock) => members.some(member => member.id === block.id)).every((block: CanvasBlock) => !block.group)).toBe(true);
  const current = await cohort();
  const approved = await request(`/canvases/${canvas.id}/jev/groups/approve`, 'POST', { groupKey: 'custom:release/staged', proposalIds: current.map(proposal => proposal.id) });
  expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200);
  const result = await approved.json();
  expect(result).toMatchObject({ groupKey: 'custom:release/staged', approvedProposalIds: expect.arrayContaining(current.map(proposal => proposal.id)), receipts: expect.any(Array) });
  expect(result.approvedProposalIds).toHaveLength(2); expect(result.receipts).toHaveLength(2);
  const saved = await request(`/canvases/${canvas.id}`).then(response => response.json());
  expect(saved.blocks.filter((block: CanvasBlock) => members.some(member => member.id === block.id)).every((block: CanvasBlock) => block.group === 'custom:release/staged')).toBe(true);
  expect(saved.blocks.find((block: CanvasBlock) => block.id === members[1].id).tags).toEqual(['manual correction']);
  expect((await request(`/canvases/${canvas.id}/jev/agent/groups/approve`, 'POST', { groupKey: 'custom:release/staged', proposalIds: current.map(proposal => proposal.id) }, { 'x-symbiknow-actor': 'workspace-owner' })).status).toBe(403);
});

it('checks parent Undo atomically and refuses a manually changed parent without deleting content', async () => {
  const { request } = await fixture();
  const created = await request('/canvases/product-roadmap/blocks', 'POST', { title: 'Agent parent', kind: 'markdown', content: '# Parent source' }).then(response => response.json()) as CanvasBlock;
  expect((await request('/canvases/product-roadmap/jev/undo-parent', 'POST', { kind: 'created', after: created })).status).toBe(200);
  const manual = await request('/canvases/product-roadmap/blocks', 'POST', { title: 'Manual parent', kind: 'markdown', content: '# Keep source' }).then(response => response.json()) as CanvasBlock;
  await request(`/canvases/product-roadmap/blocks/${manual.id}`, 'PUT', { tags: ['human-correction'] });
  expect((await request('/canvases/product-roadmap/jev/undo-parent', 'POST', { kind: 'created', after: manual })).status).toBe(409);
  expect((await request(`/canvases/product-roadmap/blocks/${manual.id}`).then(response => response.json())).content).toBe('# Keep source');
});


it('rejects the seven removed actions through owner and scoped agent HTTP before paid or durable work', async () => {
  const remote = provider(); const { request, state, root } = await fixture(remote);
  const store = new CanvasStore(root);
  const created = await store.createMcpToken('Removed action checks', 'propose', {
    allowedCanvasIds: ['product-roadmap'], tools: ['jev_propose'] });
  const headers = { authorization: `Bearer ${created.token}` };
  const before = await state();
  for (const action of ['vocab_lifecycle', 'score_quality', 'flag_conflict', 'recheck_links', 'attach_doc_to_task', 'assign_owner', 'recall']) {
    for (const prefix of ['', '/agent']) {
      const rejected = await request(`/canvases/product-roadmap/jev${prefix}/actions`, 'POST',
        { action, blockIds: ['roadmap-overview'] }, prefix ? headers : {});
      expect(rejected.status, action).toBe(400);
    }
  }
  expect(await state()).toEqual(before);
  expect(remote).not.toHaveBeenCalled();
});
