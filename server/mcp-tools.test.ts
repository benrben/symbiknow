import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CanvasBlock } from '../shared/types.js';
import { createProjectMcpServer, type ProjectMcpOptions } from './mcp.js';

const connections: Array<{ client: Client; server: McpServer }> = [];
const roots: string[] = [];
type Request = { path: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> };
const block: CanvasBlock = { id: 'doc', title: 'Document', file: 'docs/doc.md', kind: 'markdown', content: '# Document', contentHash: 'hash', x: 0, y: 0, width: 100, height: 100, links: ['target', 'other'] };
async function connect(handler: (request: Request) => Response | Promise<Response>, options: ProjectMcpOptions = {}, name = 'test-agent', apiBase: string | undefined = 'http://127.0.0.1:8787/api') {
  const requests: Request[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { path: new URL(String(input)).pathname + new URL(String(input)).search, method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>, headers: init?.headers as Record<string, string> };
    requests.push(request); return handler(request);
  }) as unknown as typeof fetch;
  const server = createProjectMcpServer(apiBase, fetcher, options);
  const client = new Client({ name, version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  connections.push({ client, server });
  async function call(name: string, args: Record<string, unknown> = {}) {
    const output = await client.callTool({ name, arguments: args });
    const first = (output.content as Array<{ text: string }>)[0];
    return { output, text: first.text, value: output.isError ? undefined : JSON.parse(first.text) as Record<string, unknown> };
  }
  return { client, server, call, requests };
}
async function temporary() { const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-mcp-tools-')); roots.push(root); return root; }
beforeEach(() => {
  for (const name of ['CANVAS_API_TOKEN', 'SYMBIKNOW_ACCESS_TOKEN', 'ALLTEAM_ACCESS_TOKEN', 'SYMBIKNOW_AGENT_NAME', 'ALLTEAM_AGENT_NAME', 'CANVAS_API_URL']) vi.stubEnv(name, '');
});
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('public MCP tool request contracts', () => {
  it('keeps document search, branch reads, and reviewed HTML writes scoped to the requested canvas', async () => {
    const html = '<!doctype html><title>Guide</title>';
    const { call, requests } = await connect(request => Response.json({
      ...block, ...request.body,
      content: request.body?.content ?? (request.path.includes('?branch=') ? `---\nformat: html\n---\n${html}` : block.content),
    }));
    expect((await call('search_docs', { query: 'guide & review', canvasId: 'canvas two', limit: 7, cursor: 'next/page' })).output.isError).not.toBe(true);
    expect((await call('read_canvas', { canvasId: 'canvas two', includeContent: false, limit: 7, cursor: 'next/page' })).output.isError).not.toBe(true);
    expect((await call('read_doc', { canvasId: 'canvas two', blockId: 'doc', branch: 'private/review' })).value)
      .toMatchObject({ kind: 'html', storageKind: 'markdown' });
    expect((await call('read_doc', { canvasId: 'canvas two', blockId: 'doc' })).value)
      .toMatchObject({ kind: 'markdown', content: block.content });
    expect((await call('create_doc', { canvasId: 'canvas two', title: 'Guide', kind: 'html', content: html })).value)
      .toMatchObject({ kind: 'html', storageKind: 'markdown' });
    const beforeRejectedEdit = requests.length;
    expect((await call('edit_doc', { canvasId: 'canvas two', blockId: 'doc', content: 'Updated' })).text)
      .toContain('expectedContentHash from read_doc is required');
    expect(requests).toHaveLength(beforeRejectedEdit);
    expect((await call('edit_doc', { canvasId: 'canvas two', blockId: 'doc', branch: 'private/review',
      expectedContentHash: 'reviewed-hash', kind: 'html', content: html })).value)
      .toMatchObject({ kind: 'html', storageKind: 'markdown' });
    expect((await call('edit_doc', { canvasId: 'canvas two', blockId: 'doc', expectedContentHash: 'reviewed-hash',
      content: '# Updated' })).value).toMatchObject({ kind: 'markdown', content: '# Updated' });
    expect(requests.map(request => [request.method, request.path])).toEqual([
      ['GET', '/api/search?q=guide%20%26%20review&canvasId=canvas%20two&limit=7&cursor=next%2Fpage'],
      ['GET', '/api/canvases/canvas%20two?includeContent=false&limit=7&cursor=next%2Fpage'],
      ['GET', '/api/canvases/canvas%20two/blocks/doc?branch=private%2Freview'],
      ['GET', '/api/canvases/canvas%20two/blocks/doc'],
      ['POST', '/api/canvases/canvas%20two/blocks'],
      ['PUT', '/api/canvases/canvas%20two/blocks/doc?branch=private%2Freview'],
      ['PUT', '/api/canvases/canvas%20two/blocks/doc'],
    ]);
    expect(requests[4].body).toMatchObject({ kind: 'markdown', content: `---\nformat: html\n---\n${html}` });
    expect(requests[5].body).toMatchObject({ kind: 'markdown', expectedContentHash: 'reviewed-hash' });
    expect(requests[5].body).not.toHaveProperty('branch');
  });

  it('forwards bounded task and revision pages with filters and opaque cursors', async () => {
    const { call, requests } = await connect(() => Response.json({ items: [], nextCursor: 'opaque-next' }));
    for (const [name, args] of [
      ['list_tasks', { canvasId: 'canvas', status: 'blocked', assignee: 'Ada Lovelace', limit: 7, cursor: 'page/2' }],
      ['task_history', { canvasId: 'canvas', taskId: 'task/one', limit: 7, cursor: 'page/2' }],
      ['list_versions', { canvasId: 'canvas', blockId: 'doc/one', limit: 7, cursor: 'page/2' }],
      ['task_history', { canvasId: 'canvas', taskId: 'task/one' }],
      ['list_versions', { canvasId: 'canvas', blockId: 'doc/one' }],
    ] as const) expect((await call(name, args)).value).toMatchObject({ items: [], nextCursor: 'opaque-next' });
    expect(requests.map(request => request.path)).toEqual([
      '/api/canvases/canvas/tasks?status=blocked&assignee=Ada+Lovelace&limit=7&cursor=page%2F2',
      '/api/canvases/canvas/tasks/task%2Fone/history?limit=7&cursor=page%2F2',
      '/api/canvases/canvas/blocks/doc%2Fone/versions?limit=7&cursor=page%2F2',
      '/api/canvases/canvas/tasks/task%2Fone/history',
      '/api/canvases/canvas/blocks/doc%2Fone/versions',
    ]);
  });

  it('maps document, task, lock, and version actions with safe defaults', async () => {
    const { call, requests } = await connect(request => Response.json(request.method === 'GET' && request.path === '/api/canvases/canvas' ? { blocks: [block, { ...block, id: 'target' }] } : { ok: true }));
    const operations: Array<[string, Record<string, unknown>]> = [
      ['list_canvases', {}], ['read_canvas', { canvasId: 'canvas' }], ['search_docs', { query: 'release plan' }],
      ['move_block', { canvasId: 'canvas', blockId: 'doc', x: 10, y: -20 }], ['delete_doc', { canvasId: 'canvas', blockId: 'doc', expectedContentHash: 'hash' }],
      ['claim_doc', { canvasId: 'canvas', blockId: 'doc', ttlSeconds: 60, note: 'Review' }], ['release_doc', { canvasId: 'canvas', blockId: 'doc' }],
      ['release_doc', { canvasId: 'canvas', blockId: 'doc', force: true }], ['list_tasks', { canvasId: 'canvas' }],
      ['create_task', { canvasId: 'canvas', title: 'Review' }], ['update_task', { canvasId: 'canvas', taskId: 'task', assignee: null, status: 'done' }],
      ['task_history', { canvasId: 'canvas', taskId: 'task', limit: 5 }],
      ['undo_task', { canvasId: 'canvas', taskId: 'task', eventId: 'event', expectedRevision: 2 }],
      ['claim_task', { canvasId: 'canvas', taskId: 'task' }], ['claim_task', { canvasId: 'canvas', taskId: 'task', force: true }],
      ['comment_task', { canvasId: 'canvas', taskId: 'task', text: 'Ready' }],
      ['restore_revision', { canvasId: 'canvas', blockId: 'doc', revision: 'abcdef0' }],
    ];
    for (const [name, args] of operations) expect((await call(name, args)).output.isError).not.toBe(true);
    expect(requests.map(request => [request.method, request.path, request.body])).toEqual([
      ['GET', '/api/workspaces?stats=1', undefined], ['GET', '/api/canvases/canvas', undefined], ['GET', '/api/search?q=release%20plan', undefined],
      ['PUT', '/api/canvases/canvas/blocks/doc', { x: 10, y: -20 }], ['DELETE', '/api/canvases/canvas/blocks/doc', { expectedContentHash: 'hash' }],
      ['POST', '/api/canvases/canvas/blocks/doc/lock', { ttlSeconds: 60, note: 'Review' }], ['DELETE', '/api/canvases/canvas/blocks/doc/lock', undefined],
      ['DELETE', '/api/canvases/canvas/blocks/doc/lock?force=1', undefined], ['GET', '/api/canvases/canvas/tasks', undefined],
      ['POST', '/api/canvases/canvas/tasks', { title: 'Review' }], ['PUT', '/api/canvases/canvas/tasks/task', { status: 'done', assignee: null }],
      ['GET', '/api/canvases/canvas/tasks/task/history?limit=5', undefined],
      ['POST', '/api/canvases/canvas/tasks/task/undo', { eventId: 'event', expectedRevision: 2 }],
      ['POST', '/api/canvases/canvas/tasks/task/claim', { force: false }], ['POST', '/api/canvases/canvas/tasks/task/claim', { force: true }],
      ['POST', '/api/canvases/canvas/tasks/task/comments', { text: 'Ready' }],
      ['POST', '/api/canvases/canvas/blocks/doc/versions/restore', { revision: 'abcdef0' }],
    ]);
  });

  it('deduplicates links, unlinks only the target, and rejects nonexistent endpoints', async () => {
    const { call, requests } = await connect(request => request.body?.fromBlockId === 'missing' || request.body?.toBlockId === 'missing'
      ? Response.json({ error: 'Both documents must exist on the canvas.' }, { status: 404 })
      : Response.json({ links: request.body?.action === 'link' ? ['target', 'other'] : ['other'] }));
    const args = { canvasId: 'canvas', fromBlockId: 'doc', toBlockId: 'target' };
    expect((await call('link_blocks', args)).value).toEqual({ links: ['target', 'other'] });
    expect((await call('unlink_blocks', args)).value).toEqual({ links: ['other'] });
    expect((await call('link_blocks', { ...args, fromBlockId: 'missing' })).text).toContain('Both documents must exist');
    expect((await call('link_blocks', { ...args, toBlockId: 'missing' })).text).toContain('Both documents must exist');
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(4);
  });

  it('shows API and transport failures and keeps malformed error responses visible', async () => {
    let mode = 'missing';
    const { call } = await connect(() => {
      if (mode === 'missing') return Response.json({ error: 'Document not found.' }, { status: 404 });
      if (mode === 'payload') return Response.json({ error: 'API denied the request' }, { status: 403 });
      if (mode === 'null') return Response.json(null, { status: 500 });
      if (mode === 'invalid') return new Response('not JSON', { status: 502 });
      if (mode === 'empty') return Response.json({ error: '' }, { status: 503 });
      throw new Error('Disconnected');
    });
    expect((await call('read_doc', { canvasId: 'canvas', blockId: 'missing' })).text).toContain('Document not found.');
    for (const [state, message] of [['payload', 'API denied the request'], ['null', 'Canvas API request failed (500)'], ['invalid', 'Canvas API request failed (502)'], ['empty', 'Canvas API request failed (503)'], ['network', 'Canvas API is unavailable']]) {
      mode = state; expect((await call('list_canvases')).text).toContain(message);
    }
  });

  it('derives actors and auth headers from current, legacy, and client identities', async () => {
    for (const [key, value, actor] of [['CANVAS_API_TOKEN', 'api-token', 'Codex'], ['SYMBIKNOW_ACCESS_TOKEN', 'new-token', 'Codex'], ['ALLTEAM_ACCESS_TOKEN', 'legacy-token', 'Codex']]) {
      vi.stubEnv(key, value);
      const { call, requests } = await connect(() => Response.json([]), { actorSuffix: 'Reviewer', headers: { custom: 'header' } }, 'codex');
      await call('list_canvases'); expect(requests[0].headers).toMatchObject({ authorization: `Bearer ${value}`, 'x-symbiknow-actor': `${actor} - Reviewer`, custom: 'header' });
      vi.stubEnv(key, '');
    }
    const { call, requests } = await connect(() => Response.json([]), {}, '');
    await call('list_canvases'); expect(requests[0].headers['x-symbiknow-actor']).toBe('MCP agent');
  });
});

describe('public MCP local and remote file transfer', () => {
  it('validates upload inputs and enforces file size before reaching the API', async () => {
    const root = await temporary(); const file = path.join(root, 'note.md'); await writeFile(file, '# Note');
    const tooLarge = path.join(root, 'large.md'); await writeFile(tooLarge, Buffer.alloc(999_901));
    const { call, requests } = await connect(() => Response.json(block));
    expect((await call('upload_file', { canvasId: 'canvas', filename: 'note.md', sourcePath: file, content: 'both' })).text).toContain('Provide content or sourcePath, not both.');
    expect((await call('upload_file', { canvasId: 'canvas', filename: 'note.md' })).text).toContain('Provide the complete file content.');
    expect((await call('upload_file', { canvasId: 'canvas', content: '# Note' })).text).toContain('filename is required');
    expect((await call('upload_file', { canvasId: 'canvas', sourcePath: tooLarge })).text).toContain('file is too large');
    expect(requests).toEqual([]);
  });

  it('uploads local files and preserves explicit overwrite review metadata', async () => {
    const root = await temporary(); const file = path.join(root, 'note.md'); await writeFile(file, '# Local note');
    const { call, requests } = await connect(request => Response.json({ ...block, ...request.body }));
    expect((await call('upload_file', { canvasId: 'canvas', sourcePath: file })).value).toMatchObject({ overwritten: false, content: '# Local note' });
    expect((await call('upload_file', { canvasId: 'canvas', blockId: 'doc', sourcePath: file, filename: 'alternate.md', title: 'Replacement', expectedContentHash: 'hash', message: 'Reviewed' })).value)
      .toMatchObject({ overwritten: true, title: 'Replacement', content: '# Local note' });
    expect(requests[1].body).toEqual({ content: '# Local note', kind: 'markdown', title: 'Replacement', expectedContentHash: 'hash', message: 'Reviewed' });
  });

  it('guards replacement hashes and preserves HTML source and loader identity in upload and download responses', async () => {
    const html = '<!doctype html><title>Offline page</title>';
    const { call, requests } = await connect(request => Response.json({ ...block, ...request.body, file: 'docs/page.md',
      ...(request.method === 'GET' ? { content: `---\nformat: html\n---\n${html}` } : {}) }));
    expect((await call('upload_file', { canvasId: 'canvas', blockId: 'doc', filename: 'page.html', content: html })).text)
      .toContain('expectedContentHash from read_doc is required');
    expect(requests).toEqual([]);
    const created = await call('upload_file', { canvasId: 'canvas', filename: 'page.html', content: html });
    expect(created.value).toMatchObject({ kind: 'html', storageKind: 'markdown', overwritten: false });
    const replaced = await call('upload_file', { canvasId: 'canvas', blockId: 'doc', filename: 'page.html',
      content: html, expectedContentHash: 'reviewed-hash' });
    expect(replaced.value).toMatchObject({ kind: 'html', storageKind: 'markdown', overwritten: true });
    expect(requests[1].body).toEqual({ content: `---\nformat: html\n---\n${html}`, kind: 'markdown', expectedContentHash: 'reviewed-hash' });

    const downloaded = await call('download_file', { canvasId: 'canvas', blockId: 'doc' });
    expect(downloaded.value).toMatchObject({ kind: 'html', storageKind: 'markdown', filename: 'page.md',
      content: `---\nformat: html\n---\n${html}` });
    expect(downloaded.value).not.toHaveProperty('savedTo');
  });

  it('writes downloads exclusively unless overwrite is requested', async () => {
    const root = await temporary(); const destinationPath = path.join(root, 'saved.md');
    const { call } = await connect(() => Response.json(block));
    expect((await call('download_file', { canvasId: 'canvas', blockId: 'doc', destinationPath })).value).toMatchObject({ savedTo: destinationPath, content: '# Document' });
    await writeFile(destinationPath, 'Keep existing');
    expect((await call('download_file', { canvasId: 'canvas', blockId: 'doc', destinationPath })).output.isError).toBe(true);
    expect(await readFile(destinationPath, 'utf8')).toBe('Keep existing');
    expect((await call('download_file', { canvasId: 'canvas', blockId: 'doc', destinationPath, overwrite: true })).output.isError).not.toBe(true);
    expect(await readFile(destinationPath, 'utf8')).toBe('# Document');
  });

  it('does not grant remote clients local path parameters', async () => {
    const root = await temporary(); const file = path.join(root, 'private.md'); await writeFile(file, '# Private');
    const destinationPath = path.join(root, 'remote.md');
    const { client, call, requests } = await connect(() => Response.json(block), { localFiles: false });
    const listed = (await client.listTools()).tools;
    expect(listed.find(tool => tool.name === 'upload_file')?.inputSchema.properties).not.toHaveProperty('sourcePath');
    expect(listed.find(tool => tool.name === 'download_file')?.inputSchema.properties).not.toHaveProperty('destinationPath');
    expect((await call('upload_file', { canvasId: 'canvas', sourcePath: file })).output.isError).toBe(true);
    await call('upload_file', { canvasId: 'canvas', filename: 'public.md', content: '# Public' });
    const downloaded = await call('download_file', { canvasId: 'canvas', blockId: 'doc', destinationPath, overwrite: true });
    expect(downloaded.value).not.toHaveProperty('savedTo');
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(requests[0].body).toMatchObject({ content: '# Public' });
  });
});
