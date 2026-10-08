import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { AIMessage } from '@langchain/core/messages';
import { createApiServer } from './index.js';
import type { DeepAgentFactory } from './chat-stream.js';

const opened: Array<{ server: Server; root: string }> = [];
async function fixture(factory: DeepAgentFactory, fetcher?: typeof fetch) {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-chat-contract-'));
  const server = await createApiServer({ dataDir: root, agentFactory: factory, fetcher });
  opened.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return `http://127.0.0.1:${address.port}`;
}
async function post(base: string, route: string, body: unknown, signal?: AbortSignal) {
  return fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal });
}
afterEach(async () => {
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it('uses the configured provider and canonical MCP tools for non-streaming chat', async () => {
  const upstream = vi.fn(async () => Response.json({ choices: [{ message: { content: 'unsafe legacy answer' } }] })) as typeof fetch;
  const factory: DeepAgentFactory = vi.fn<DeepAgentFactory>((settings, tools) => {
    expect(settings).toMatchObject({ provider: 'custom', apiKey: 'custom-fixture', baseURL: 'http://localhost:1234/v1' });
    expect(tools.some(tool => tool.name === 'edit_doc')).toBe(false);
    expect(tools.some(tool => tool.name === 'read_doc')).toBe(true);
    expect(tools.some(tool => tool.name === 'upload_file')).toBe(true);
    return async function* (messages) { yield { messages: [...messages, new AIMessage('Safe answer')] }; };
  });
  const base = await fixture(factory, upstream);
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'custom', apiKey: 'custom-fixture', model: 'custom-model',
      baseUrl: 'http://localhost:1234/v1', agentPlugins: [] }) });
  const response = await post(base, '/api/chat', { canvasId: 'product-roadmap', messages: [{ role: 'user', content: 'Hello' }] });
  expect(await response.json()).toMatchObject({ message: 'Safe answer', changed: false });
  expect(factory).toHaveBeenCalledOnce();
  expect(upstream).not.toHaveBeenCalled();
});
