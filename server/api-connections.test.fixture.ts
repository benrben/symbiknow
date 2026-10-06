import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

const servers: Server[] = [];
const roots: string[] = [];
const remotes: McpServer[] = [];

async function dataRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'allteam-connections-'));
  roots.push(root);
  return root;
}
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing connection fixture address');
  return `http://127.0.0.1:${address.port}`;
}

export async function fixture() {
  const root = await dataRoot();
  const server = await createApiServer({ dataDir: root });
  return { base: await listen(server), root, store: new CanvasStore(root) };
}

export async function request(base: string, route: string, body?: unknown, method = 'POST', headers: Record<string, string> = {}) {
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

export async function documentServer(requiredHeaders: Record<string, string> = {}) {
  const root = await dataRoot();
  const store = new CanvasStore(root);
  await store.init();
  const block = await store.createBlock('product-roadmap', { title: 'Connection proof', content: '# Actual persisted MCP source\n' });
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const observed: Array<{ method: string; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createServer(async (incoming, response) => {
    observed.push({ method: incoming.method!, headers: { ...incoming.headers } });
    if (Object.entries(requiredHeaders).some(([name, value]) => incoming.headers[name.toLowerCase()] !== value)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Remote fixture rejected authentication' }));
      return;
    }
    const session = incoming.headers['mcp-session-id'];
    let transport = typeof session === 'string' ? sessions.get(session) : undefined;
    if (!transport && incoming.method === 'POST') {
      const mcp = new McpServer({ name: 'Native document library', version: '1.0' });
      mcp.registerTool('read_document', { description: 'Reads a persisted document', inputSchema: { blockId: z.string() } }, async ({ blockId }) => {
        const canvas = await new CanvasStore(root).getCanvas('product-roadmap');
        const document = canvas.blocks.find(item => item.id === blockId);
        if (!document) throw new Error('Document not found');
        return { content: [{ type: 'text', text: document.content }] };
      });
      remotes.push(mcp);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => { sessions.set(id, transport!); } });
      await mcp.connect(transport);
    }
    if (!transport) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'No remote MCP session' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    await transport.handleRequest(incoming, response, chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
  });
  return { url: await listen(server), root, store, block, observed };
}

export async function catalogServer() {
  const root = await dataRoot();
  const file = path.join(root, 'catalog.json');
  await writeFile(file, JSON.stringify({ status: 401, data: [] }));
  const observed: Array<{ url: string; authorization: string | undefined }> = [];
  const server = createServer(async (incoming, response) => {
    observed.push({ url: incoming.url!, authorization: incoming.headers.authorization });
    const catalog = JSON.parse(await readFile(file, 'utf8')) as { status: number; data: Array<{ id: string }> };
    response.writeHead(catalog.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: catalog.data }));
  });
  return { url: await listen(server), file, observed };
}

afterEach(async () => {
  await Promise.all(remotes.splice(0).map(remote => remote.close()));
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});
