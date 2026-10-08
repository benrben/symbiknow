import { describe, expect, it } from 'vitest';
import { CanvasApi } from './mcp-api.js';

describe('Canvas API request headers', () => {
  it('reads dynamic headers again for every request so rotated credentials apply immediately', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetcher = (async (_input: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return Response.json({ id: 'launch-checklist', title: 'Launch checklist' });
    }) as unknown as typeof fetch;
    let token = 'first-session';
    const api = new CanvasApi('http://127.0.0.1:8787/api', fetcher, () => ({ authorization: `Bearer ${token}` }));
    await api.block('product-roadmap', 'launch-checklist');
    token = 'rotated-session';
    await expect(api.request('/canvases/product-roadmap/blocks/launch-checklist', 'POST', { title: 'Revised' }))
      .resolves.toMatchObject({ id: 'launch-checklist' });
    expect(seen).toEqual([{ authorization: 'Bearer first-session' },
      { authorization: 'Bearer rotated-session', 'content-type': 'application/json' }]);
  });
});
