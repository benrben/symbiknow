import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CanvasStore } from '../../server/storage.ts';
import { createStoreApiFetcher } from '../../server/api-inprocess.ts';
import { symbiApiHeaders } from '../../server/jev-api-principal.ts';
import { symbiMcpTools } from '../../server/symbi-mcp-client.ts';
import { projectMcpMetadata } from '../../server/mcp-registry.ts';

const original = '# Agent chart\n\n<Chart title="Status" values="2,4" />\n';
const edited = '# Agent chart\n\n<Chart title="Status" values="2,4,8" />\n';
async function api(world, route, method = 'GET', body) {
  const response = await fetch(`${world.baseUrl}/api${route}`, { method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
function decoded(output) { return JSON.parse(output.content[0].text); }
async function tool(client, name, args) {
  const output = await client.callTool({ name, arguments: args });
  assert.ok(!output.isError, JSON.stringify(output));
  return decoded(output);
}
async function connect(world, access, scope = {}) {
  const created = await api(world, '/mcp/tokens', 'POST', { name: `File acceptance ${access}`, access, ...scope });
  const client = new Client({ name: 'file-workflow-acceptance', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${world.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${created.token}` } },
  }));
  (world.fileClients ??= []).push(client);
  return client;
}
async function otherCanvas(world) {
  const workspaces = await api(world, '/workspaces');
  return api(world, `/workspaces/${workspaces[0].id}/canvases`, 'POST', { name: 'Agent file scope' });
}
After(async function () {
  await this.nativeSymbi?.close();
  for (const client of this.fileClients ?? []) await client.close();
});

Given('a writable MCP file client', async function () {
  this.fileClient = await connect(this, 'write');
  this.fileWorkingDirectory = join(this.dataDir, 'acceptance-agent-files');
  await mkdir(this.fileWorkingDirectory);
});
When('the MCP file client creates an MDX document from a local file', async function () {
  this.workingFile = join(this.fileWorkingDirectory, 'agent-chart.mdx');
  await writeFile(this.workingFile, original);
  this.fileReceipt = await tool(this.fileClient, 'upload_file', { mode: 'create', canvasId: this.canvasId,
    filename: 'agent-chart.mdx', kind: 'mdx', title: 'Agent chart', content: await readFile(this.workingFile, 'utf8'), idempotencyKey: 'acceptance-create' });
  assert.equal(this.fileReceipt.kind, 'mdx');
});
When('the MCP file client downloads and edits its local working copy', async function () {
  this.download = await tool(this.fileClient, 'download_file', { canvasId: this.canvasId, blockId: this.fileReceipt.blockId });
  assert.equal(this.download.content, original);
  assert.equal(this.download.manifest.kind, 'mdx');
  assert.match(this.download.filename, /\.mdx$/);
  await writeFile(this.workingFile, this.download.content);
  await writeFile(this.workingFile + '.symbi.json', JSON.stringify(this.download.manifest));
  await writeFile(this.workingFile, edited);
  this.historyBeforeUpload = await tool(this.fileClient, 'list_versions', { canvasId: this.canvasId, blockId: this.fileReceipt.blockId });
});
When('the MCP file client uploads its working copy twice with the same key', async function () {
  const manifest = JSON.parse(await readFile(this.workingFile + '.symbi.json', 'utf8'));
  const input = { mode: 'replace', canvasId: manifest.canvasId, checkoutId: manifest.checkoutId,
    filename: this.download.filename, content: await readFile(this.workingFile, 'utf8'), idempotencyKey: 'acceptance-replace' };
  this.firstFileSave = await tool(this.fileClient, 'upload_file', input);
  this.retriedFileSave = await tool(this.fileClient, 'upload_file', input);
});
Then('the saved MDX source matches the local file after reopening the workspace', async function () {
  const canvas = await api(this, `/canvases/${this.canvasId}`);
  const saved = canvas.blocks.find(block => block.id === this.fileReceipt.blockId);
  assert.equal(saved.kind, 'mdx');
  assert.equal(saved.content, edited);
  assert.equal(await readFile(join(this.dataDir, saved.file), 'utf8'), await readFile(this.workingFile, 'utf8'));
  assert.equal((await tool(this.fileClient, 'read_doc', { canvasId: this.canvasId, blockId: saved.id })).contentHash, this.firstFileSave.contentHash);
});
Then('the repeated upload returns one receipt and one new revision', async function () {
  assert.deepEqual(this.retriedFileSave, this.firstFileSave);
  const after = await tool(this.fileClient, 'list_versions', { canvasId: this.canvasId, blockId: this.fileReceipt.blockId });
  assert.equal(after.commits.length, this.historyBeforeUpload.commits.length + 1);
  assert.equal(after.commits[0].id, this.firstFileSave.revision);
});
When('a read-only MCP file client attempts to upload and read outside its canvas', async function () {
  const reader = await connect(this, 'read', { allowedCanvasIds: [this.canvasId] });
  const outside = await otherCanvas(this);
  const outsideDocument = await tool(this.fileClient, 'upload_file', { mode: 'create', canvasId: outside.id,
    filename: 'private.mdx', kind: 'mdx', content: '# Other canvas source', idempotencyKey: 'outside-create' });
  this.restrictedBaseline = await api(this, `/canvases/${this.canvasId}`);
  this.restrictedUpload = await reader.callTool({ name: 'upload_file', arguments: { mode: 'create', canvasId: this.canvasId,
    filename: 'denied.md', content: '# Must remain absent', idempotencyKey: 'denied-upload' } });
  this.restrictedRead = await reader.callTool({ name: 'read_doc', arguments: { canvasId: outside.id, blockId: outsideDocument.blockId } });
  const names = (await reader.listTools()).tools.map(item => item.name);
  assert.ok(!names.includes('upload_file'));
  assert.ok(!names.includes('jev_resolve'));
});
Then('both restricted MCP operations are denied without changing saved documents', async function () {
  assert.equal(this.restrictedUpload.isError, true);
  assert.equal(this.restrictedRead.isError, true);
  assert.ok(!JSON.stringify(this.restrictedRead).includes('Other canvas source'));
  const current = await api(this, `/canvases/${this.canvasId}`);
  assert.deepEqual(current.blocks, this.restrictedBaseline.blocks);
});
When('native Symbi connects to the canonical MCP catalog', async function () {
  this.symbiStore = new CanvasStore(this.dataDir);
  this.nativeWorkdir = join(this.dataDir, 'native-symbi-files');
  await mkdir(this.nativeWorkdir);
  this.nativeSymbi = await symbiMcpTools({ store: this.symbiStore, canvasId: this.canvasId, query: 'Edit a working file',
    workdir: this.nativeWorkdir, navigationRequests: [], researchPatches: [] }, {
    mcpApiBase: 'http://embedded/api', mcpFetcher: createStoreApiFetcher(this.symbiStore), mcpHeaders: symbiApiHeaders(),
  });
});
Then('native Symbi discovers every tool including Jev search and explicit reviewer tools', function () {
  const names = this.nativeSymbi.tools.map(item => item.name);
  assert.deepEqual(names, projectMcpMetadata().map(item => item.name));
  for (const name of ['ask_symbi', 'symbi_reflex', 'find_by', 'related', 'jev_do', 'jev_resolve', 'jev_configure', 'apply_file_proposal']) assert.ok(names.includes(name), name);
});
When('native Symbi downloads edits and uploads a file on another canvas', async function () {
  this.symbiOtherCanvas = await otherCanvas(this);
  const block = await api(this, `/canvases/${this.symbiOtherCanvas.id}/blocks`, 'POST', { title: 'Other canvas MDX', kind: 'mdx', content: original });
  this.symbiOtherBlockId = block.id;
  const byName = name => this.nativeSymbi.tools.find(item => item.name === name);
  const downloaded = JSON.parse(String(await byName('download_file').invoke({ canvasId: this.symbiOtherCanvas.id, blockId: block.id })));
  await writeFile(join(this.nativeWorkdir, downloaded.savedTo.replace(/^\//, '')), edited);
  this.symbiReceipt = JSON.parse(String(await byName('upload_file').invoke({ sourcePath: downloaded.savedTo })));
  assert.equal(this.symbiReceipt.canvasId, this.symbiOtherCanvas.id);
});
Then('the Symbi file edit is durable outside its active canvas', async function () {
  const saved = await api(this, `/canvases/${this.symbiOtherCanvas.id}/blocks/${this.symbiOtherBlockId}`);
  assert.equal(saved.kind, 'mdx');
  assert.equal(saved.content, edited);
  assert.equal(saved.contentHash, this.symbiReceipt.contentHash);
  const history = await api(this, `/canvases/${this.symbiOtherCanvas.id}/blocks/${this.symbiOtherBlockId}/versions`);
  assert.equal(history.commits[0].author, 'symbi');
  const activity = await api(this, '/mcp/activity');
  assert.ok(activity.entries.some(entry => entry.tokenId === 'symbi' && entry.tool === 'upload_file' && entry.outcome === 'success'));
});
