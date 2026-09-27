import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

it('preserves a JSON error from the application server', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'OpenRouter request failed (429): Rate limit' }, { status: 502 })));
  await expect(api('/chat')).rejects.toThrow('OpenRouter request failed (429): Rate limit');
});

it('returns JSON and supplies the content type for a request body', async () => {
  const fetcher = vi.fn(async () => Response.json({ saved: true }));
  vi.stubGlobal('fetch', fetcher);
  expect(await api('/settings', { method: 'PUT', body: JSON.stringify({ model: 'vendor/model' }), headers: { 'x-request': 'test' } })).toEqual({ saved: true });
  expect(fetcher).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-symbiknow-actor': 'Browser', 'x-request': 'test' },
  }));
});

it('reports an ordinary HTTP error without a JSON body', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  await expect(api('/missing')).rejects.toThrow('Request failed (404)');
});

it('explains an HTML 502 from the development proxy', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })));
  await expect(api('/chat')).rejects.toThrow('Canvas server is unavailable or restarting (502)');
});

it('explains a refused local connection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  await expect(api('/chat')).rejects.toThrow('Canvas server is unavailable');
});
