import { afterAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }));

import { mcpSessionCount } from './mcp-http.js';
import { remoteMcpFixture, rpcRequest, sdkClient } from './mcp-http.test.fixture.js';

afterAll(() => vi.useRealTimers());

describe('remote MCP idle lifecycle', () => {
  it('expires idle sessions after one hour, retains a recently used session, and permits a fresh SDK connection', async () => {
    const { base, store } = await remoteMcpFixture();
    const { token } = await store.createMcpToken('Idle lifecycle reader', 'read');
    const baseline = mcpSessionCount();
    const active = await sdkClient(base, token);
    const idle = await sdkClient(base, token);
    const expiredId = idle.transport.sessionId;
    expect(mcpSessionCount()).toBe(baseline + 2);
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect((await active.client.listTools()).tools.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(mcpSessionCount()).toBe(baseline + 1);
    const expired = await rpcRequest(base, token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, expiredId);
    expect(expired.status).toBe(404);
    await expired.text();
    expect((await active.client.listTools()).tools.length).toBeGreaterThan(0);
    const reconnected = await sdkClient(base, token);
    expect(reconnected.transport.sessionId).not.toBe(expiredId);
    expect(mcpSessionCount()).toBe(baseline + 2);
  });
});
