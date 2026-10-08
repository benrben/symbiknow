import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExternalMcpServer } from '../shared/types.js';

type RemoteTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type Plan = { connectError?: unknown; closeError?: unknown; listingError?: unknown; pendingConnect?: boolean;
  pendingListing?: boolean; onConnect?: () => void; name?: string; tools?: RemoteTool[]; output?: { content?: unknown; isError?: boolean } };
type FakeClient = { plan: Plan; closed: boolean; callTool: ReturnType<typeof vi.fn> };
const fixtures = vi.hoisted(() => ({ plans: [] as Plan[], clients: [] as FakeClient[],
  transports: [] as Array<{ url: URL; options: Record<string, unknown> }> }));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  plan = fixtures.plans.shift() ?? {};
  closed = false;
  constructor() { fixtures.clients.push(this); }
  async connect() {
    this.plan.onConnect?.();
    if (this.plan.pendingConnect) await new Promise(() => undefined);
    if (this.plan.connectError !== undefined) throw this.plan.connectError;
  }
  async listTools() {
    if (this.plan.pendingListing) await new Promise(() => undefined);
    if (this.plan.listingError !== undefined) throw this.plan.listingError;
    return { tools: this.plan.tools ?? [] };
  }
  callTool = vi.fn(async () => this.plan.output ?? { content: [] });
  getServerVersion() { return this.plan.name ? { name: this.plan.name } : undefined; }
  async close() { this.closed = true; if (this.plan.closeError !== undefined) throw this.plan.closeError; }
} }));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {
  constructor(url: URL, options: Record<string, unknown>) { fixtures.transports.push({ url, options }); }
} }));
import { connectExternal, externalTools, testExternal } from './external-mcp.js';
const server: ExternalMcpServer = { id: 'docs', name: 'Docs', url: 'http://localhost:1234/mcp', enabled: true };
beforeEach(() => { fixtures.plans.length = 0; fixtures.clients.length = 0; fixtures.transports.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('tests advertised tools, resolves saved credentials, and closes the connection', async () => {
  fixtures.plans.push({ name: 'Remote documents', tools: [{ name: 'read', description: 'Read a document' }, { name: 'ping' }] });
  expect(await testExternal({ ...server, bearerSecret: 'TOKEN', headers: { 'x-team': '${secret:TEAM}' } },
    { TOKEN: 'fixture', TEAM: 'team-fixture' })).toEqual({ ok: true, server: 'Remote documents',
    tools: [{ name: 'read', description: 'Read a document' }, { name: 'ping', description: '' }] });
  expect(fixtures.transports[0].options).toEqual({ requestInit: { headers: { Authorization: 'Bearer fixture', 'x-team': 'team-fixture' } } });
  expect(fixtures.clients[0].closed).toBe(true);
});

it.each([new Error('unavailable'), 'invalid response'])('reports transport failures and releases clients: %s', async error => {
  fixtures.plans.push({ connectError: error });
  await expect(connectExternal(server, {})).rejects.toMatchObject({ status: 502 });
  expect(fixtures.clients.every(client => client.closed)).toBe(true);
});

it('uses the configured name when the remote server omits its version', async () => {
  expect(await testExternal(server, {})).toEqual({ ok: true, server: 'Docs', tools: [] });
});

it('reports cleanup failures without discarding a successful tool test', async () => {
  fixtures.plans.push({ closeError: new Error('close failed') });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect((await testExternal(server, {})).ok).toBe(true);
  expect(warning).toHaveBeenCalledWith('Could not close an external MCP connection.');
});

it('closes the connection when discovery fails', async () => {
  fixtures.plans.push({ listingError: new Error('listing failed') });
  await expect(testExternal(server, {})).rejects.toThrow('listing failed');
  expect(fixtures.clients[0].closed).toBe(true);
});

it('bounds tool discovery waits and releases the timed out client', async () => {
  vi.useFakeTimers();
  fixtures.plans.push({ pendingListing: true });
  const result = testExternal(server, {});
  const rejected = expect(result).rejects.toThrow('listing tools timed out');
  await vi.advanceTimersByTimeAsync(8001);
  await rejected;
  expect(fixtures.clients[0].closed).toBe(true);
});

it('bounds the connection attempt', async () => {
  vi.useFakeTimers();
  fixtures.plans.push({ pendingConnect: true });
  const result = connectExternal(server, {}, 10);
  const rejected = expect(result).rejects.toMatchObject({ status: 502 });
  await vi.advanceTimersByTimeAsync(21);
  await rejected;
  expect(fixtures.clients.every(client => client.closed)).toBe(true);
});

it('rejects already cancelled discovery without connecting', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(connectExternal(server, {}, 10, controller.signal)).rejects.toThrow();
  await expect(externalTools([server], {}, vi.fn(), controller.signal)).rejects.toThrow();
  expect(fixtures.clients).toHaveLength(0);
});

it('closes a connection if cancellation arrives while the SDK begins connecting', async () => {
  const controller = new AbortController();
  fixtures.plans.push({ onConnect: () => controller.abort(new Error('Connection cancelled')), pendingConnect: true });
  await expect(connectExternal(server, {}, 10, controller.signal)).rejects.toThrow('Connection cancelled');
  expect(fixtures.clients).toHaveLength(1);
  expect(fixtures.clients[0].closed).toBe(true);
});

it('skips unavailable and disabled servers while retaining usable tools', async () => {
  fixtures.plans.push({ connectError: 'unreachable' }, { tools: [{ name: 'read document', inputSchema: { type: 'object', properties: {} } }] });
  const warning = vi.fn();
  const loaded = await externalTools([{ ...server, id: 'bad' }, { ...server, id: 'good' }, { ...server, id: 'disabled', enabled: false }], {}, warning);
  expect(warning).toHaveBeenCalledWith('Docs is unavailable: Could not connect to Docs: connection failed');
  expect(loaded.tools[0].name).toMatch(/^good__read_document/);
  await loaded.close();
  expect(fixtures.clients.every(client => client.closed)).toBe(true);
});

it('imports all granted tools and bounds names while supplying missing schemas', async () => {
  fixtures.plans.push({ tools: Array.from({ length: 45 }, (_, index) => ({ name: 'x'.repeat(70) + index })) });
  const loaded = await externalTools([server], {}, vi.fn());
  expect(loaded.tools).toHaveLength(45);
  expect(loaded.tools.every(tool => tool.name.length <= 64)).toBe(true);
  expect(new Set(loaded.tools.map(tool => tool.name)).size).toBe(45);
  await loaded.close();
});

it('keeps different sanitized names distinct and rejects a cancelled session before invoking tools', async () => {
  fixtures.plans.push({ tools: [{ name: 'read document' }, { name: 'read/document' }] });
  const controller = new AbortController();
  const loaded = await externalTools([server], {}, vi.fn(), controller.signal);
  expect(new Set(loaded.tools.map(tool => tool.name)).size).toBe(2);
  controller.abort();
  await expect(loaded.tools[0].invoke({})).rejects.toThrow();
  expect(fixtures.clients[0].callTool).not.toHaveBeenCalled();
  await loaded.close();
});

it('forwards invocation cancellation alongside the session signal', async () => {
  fixtures.plans.push({ tools: [{ name: 'read' }] });
  const session = new AbortController();
  const invocation = new AbortController();
  const loaded = await externalTools([server], {}, vi.fn(), session.signal);
  await loaded.tools[0].invoke({}, { signal: invocation.signal });
  const options = fixtures.clients[0].callTool.mock.calls[0][2] as { signal: AbortSignal };
  expect(options.signal.aborted).toBe(false);
  invocation.abort();
  expect(options.signal.aborted).toBe(true);
  await loaded.close();
});

it.each([
  [{ content: [{ type: 'text', text: 'answer' }, { type: 'image', data: 'image' }, null, false] }, 'answer\n{"type":"image","data":"image"}\nnull\nfalse'],
  [{ content: [{ type: 'text' }] }, ''],
  [{ content: { result: 'answer' } }, '{"result":"answer"}'],
  [{}, '""'],
  [{ content: [{ type: 'text', text: 'failure' }], isError: true }, 'Error from Docs: failure'],
] as const)('preserves remote content and explicit tool errors', async (output, expected) => {
  fixtures.plans.push({ tools: [{ name: 'read', description: 'Remote read' }], output });
  const loaded = await externalTools([server], {}, vi.fn());
  expect(await loaded.tools[0].invoke({})).toBe(expected);
  expect(fixtures.clients[0].callTool).toHaveBeenCalledWith({ name: 'read', arguments: {} }, undefined, { signal: undefined });
  await loaded.close();
});

it('keeps discovery failure visible while closing the remaining client', async () => {
  fixtures.plans.push({ listingError: 'unavailable' });
  const warning = vi.fn();
  const loaded = await externalTools([server], {}, warning);
  expect(loaded.tools).toEqual([]);
  expect(warning).toHaveBeenCalledWith('Docs is unavailable: connection failed');
  await loaded.close();
  expect(fixtures.clients[0].closed).toBe(true);
});
