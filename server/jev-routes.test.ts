import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApiServer } from './index.js';
import { JEV_MODEL } from './jev.js';

const opened: Array<{ server: Server; dataDir: string }> = [];

async function serverFixture(): Promise<{ base: string; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-jev-routes-'));
  const server = await createApiServer({ dataDir });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, dataDir });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return { base: `http://127.0.0.1:${address.port}`, dataDir: path.resolve(dataDir) };
}

async function request(base: string, route: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(base + route, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

afterEach(async () => {
  for (const { server, dataDir } of opened.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('Jev usage and calibration routes', () => {
  it('GET /api/jev/usage returns the pinned model with zeroed totals when nothing was recorded', async () => {
    const { base } = await serverFixture();
    const response = await request(base, '/api/jev/usage');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ model: JEV_MODEL,
      month: { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      today: { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } });
  });

  it('GET /api/jev/usage reflects usage recorded under DATA_DIR/jev-usage for the current month', async () => {
    const { base, dataDir } = await serverFixture();
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await mkdir(path.join(dataDir, 'jev-usage'), { recursive: true });
    const usage = { model: JEV_MODEL, inputTokens: 1_000, outputTokens: 50, questions: 2, at: now.toISOString() };
    await appendFile(path.join(dataDir, 'jev-usage', `${month}.jsonl`), `${JSON.stringify(usage)}\n`);
    const response = await request(base, '/api/jev/usage');
    expect(response.status).toBe(200);
    const body = await response.json() as { model: string; month: { requests: number; inputTokens: number; estimatedCostUsd: number } };
    expect(body.model).toBe(JEV_MODEL);
    expect(body.month).toMatchObject({ requests: 1, inputTokens: 1_000 });
    expect(body.month.estimatedCostUsd).toBeCloseTo((1_000 * 42) / 1_000_000_000, 12);
  });

  it('GET /api/jev/calibration aggregates recorded feedback across canvases into a Show suggestion', async () => {
    const { base } = await serverFixture();
    async function feedback(canvasId: string, category: string, confidence: number, decision: string, count: number): Promise<void> {
      for (let index = 0; index < count; index++) {
        const response = await request(base, `/api/canvases/${canvasId}/insights/feedback`, 'POST',
          { itemId: `${category}-${confidence}-${decision}-${index}`, category, confidence, decision });
        expect(response.status).toBe(201);
      }
    }
    await feedback('product-roadmap', 'connection', 0.8, 'applied', 19);
    await feedback('product-roadmap', 'connection', 0.8, 'dismissed', 1);
    await feedback('product-roadmap', 'reviewer', 0.9, 'applied', 5);
    const response = await request(base, '/api/jev/calibration');
    expect(response.status).toBe(200);
    const body = await response.json() as Array<{ kind: string; suggestedShow: number | null; sampleSize: number; note?: string }>;
    expect(body.find(item => item.kind === 'link')).toMatchObject({ suggestedShow: 0.75, sampleSize: 20 });
    expect(body.find(item => item.kind === 'reviewer')).toMatchObject({ suggestedShow: null, sampleSize: 5, note: 'Not enough data' });
  });

  it('GET /api/jev/calibration returns an empty list when no feedback has been recorded', async () => {
    const { base } = await serverFixture();
    expect(await request(base, '/api/jev/calibration').then(response => response.json())).toEqual([]);
  });

  it('maps an oversized JSON body to a 413 without logging it as a server error', async () => {
    const { base } = await serverFixture();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(2_000_001) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Request body is too large' });
    expect(error).not.toHaveBeenCalled();
  });
});
