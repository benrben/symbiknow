import { describe, expect, it } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { CanvasStore } from './storage.js';
import { loopbackApi, loopbackHost, requestBodyError } from './mcp-http-protocol.js';
import { createHttpMcpTransport } from './mcp-http-sessions.js';
import { recordCall, recordMcpToolEvent } from './mcp-http-activity.js';
import { mcpSessionCount } from './mcp-http.js';
import { remoteMcpFixture } from './mcp-http.test.fixture.js';

describe('MCP HTTP lifecycle and ledger boundaries', () => {
  it.each([
    ['0.0.0.0', '127.0.0.1'], ['::', '127.0.0.1'], ['127.0.0.1', '127.0.0.1'],
    ['::ffff:127.0.0.1', '127.0.0.1'], ['::1', '[::1]'], ['2001:db8::1', '[2001:db8::1]'],
  ])('formats the local socket address %s as %s', (address, expected) => {
    expect(loopbackHost(address)).toBe(expected);
  });

  it('keeps parser errors readable and uses a safe fallback for non-Error failures', () => {
    expect(requestBodyError(new SyntaxError('Incomplete JSON'))).toBe('Incomplete JSON');
    expect(requestBodyError(undefined)).toBe('Invalid JSON');
    expect(requestBodyError('private unexpected rejection')).toBe('Invalid JSON');
  });

  it('closes an installed SDK transport before initialization without creating or removing a session', async () => {
    const { store } = await remoteMcpFixture();
    const created = await store.createMcpToken('Embedded lifecycle', 'read');
    const identity = await store.mcpTokenIdentity(created.token);
    if (!identity) throw new Error('Missing real token identity');
    const socket = new Socket();
    const request = new IncomingMessage(socket);
    expect(loopbackApi(request)).toBe('http://127.0.0.1:undefined/api');
    const baseline = mcpSessionCount();
    const transport = await createHttpMcpTransport(store, identity, request);
    await transport.close();
    socket.destroy();
    expect(transport.sessionId).toBeUndefined();
    expect(mcpSessionCount()).toBe(baseline);
  });

  it('persists standalone native tool events and refuses a revision lookup without exactly one canvas and document reference', async () => {
    const { store, root } = await remoteMcpFixture();
    const created = await store.createMcpToken('Embedded ledger', 'write');
    const identity = await store.mcpTokenIdentity(created.token);
    if (!identity) throw new Error('Missing real token identity');
    await store.documentHistory('product-roadmap', 'launch-checklist');
    const date = '2026-10-01T15:00:00.000Z';
    await recordMcpToolEvent(store, identity, { tool: 'read_doc', args: {}, startedAt: date, endedAt: date,
      outcome: 'success', result: { content: [{ type: 'text', text: JSON.stringify({ id: 'launch-checklist' }) }] } });
    await recordCall(store, identity, { name: 'read_doc', args: { canvasId: 'product-roadmap',
      blockIds: ['launch-checklist', 'pitch-slides'] } }, date, date, 'success');
    const entries = (await new CanvasStore(root).mcpActivity()).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ tool: 'read_doc', outcome: 'success', canvasIds: ['product-roadmap'],
      documentIds: ['launch-checklist', 'pitch-slides'] });
    expect(entries[1]).toMatchObject({ tool: 'read_doc', outcome: 'success', canvasIds: [], documentIds: ['launch-checklist'] });
    expect(entries.every(entry => entry.revision === undefined)).toBe(true);
  });
});
