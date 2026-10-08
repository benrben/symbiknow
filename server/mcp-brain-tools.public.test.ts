import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createProjectMcpServer } from './mcp.js';

const sessions: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => { for (const { client, server } of sessions.splice(0)) { await client.close(); await server.close(); } });
async function fixture() {
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => Response.json(JSON.parse(String(options?.body))));
  const server = createProjectMcpServer('http://local/api', fetcher, {
    access: 'read', localFiles: false, headers: { authorization: 'Bearer explicit-schema-host' },
  });
  const client = new Client({ name: 'brain-schema-boundary', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  sessions.push({ client, server });
  return { client, fetcher };
}
it.each([
  { canvasId: 'c'.repeat(65) }, { documentIds: ['d'.repeat(65)] }, { cursor: 'x'.repeat(2001) },
])('rejects oversized canonical search scope before an API request: %j', async scope => {
  const f = await fixture();
  expect((await f.client.callTool({ name: 'ask_symbi', arguments: { question: 'Find deployment evidence', mode: 'semantic', ...scope } })).isError).toBe(true);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it('accepts empty and omitted user document selections and exposes the permission distinction', async () => {
  const f = await fixture();
  const tool = (await f.client.listTools()).tools.find(tool => tool.name === 'ask_symbi')!;
  expect(tool.description).toContain('omitted or empty documentIds means no selection filter');
  expect(tool.description).toContain('Caller permissions always restrict accessible sources');
  for (const documentIds of [undefined, []]) {
    const response = await f.client.callTool({ name: 'ask_symbi', arguments: { question: 'Find deployment evidence',
      mode: 'semantic', canvasId: 'c'.repeat(64), cursor: 'x'.repeat(2000), documentIds } });
    expect(response.isError).not.toBe(true);
  }
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  const first = JSON.parse(String(f.fetcher.mock.calls[0][1]?.body));
  const second = JSON.parse(String(f.fetcher.mock.calls[1][1]?.body));
  expect(first).not.toHaveProperty('documentIds');
  expect(second.documentIds).toEqual([]);
});
