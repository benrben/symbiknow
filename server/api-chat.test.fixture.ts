import { afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { AIMessage } from '@langchain/core/messages';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';
import type { DeepAgentFactory } from './chat-stream.js';

const opened: Array<{ server: Server; root: string }> = [];
export const answerAgent: DeepAgentFactory = () => async function* (messages) {
  yield { messages: [...messages, new AIMessage('HTTP chat completed.')] };
};
export async function chatHttpFixture(options: Partial<Parameters<typeof createApiServer>[0]> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-api-chat-'));
  const server = await createApiServer({ dataDir: root, agentFactory: answerAgent, ...options });
  opened.push({ server, root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const base = `http://127.0.0.1:${address.port}`;
  const store = new CanvasStore(root);
  await store.updateSettings({ provider: 'custom', baseUrl: 'http://localhost:1234/v1', apiKey: 'fixture-key',
    model: 'fixture-model', agentPlugins: ['external_mcp'] });
  return { base, store, root };
}

export function jsonRequest(base: string, route: string, body: unknown, method = 'POST', key?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== undefined) headers['x-investigation-key'] = key;
  return fetch(base + route, { method, headers, body: JSON.stringify(body) });
}

afterEach(async () => {
  for (const { server, root } of opened.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
