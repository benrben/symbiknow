import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../server/index.js';
import { CanvasStore } from '../server/storage.js';
import type { CanvasBlock, CanvasDocument } from './types.js';
import { groupAncestors, groupKey, groupLabel, groupParent, groupPath, groupTone, normalizedGroup, validGroupKey } from './groups.js';

const opened: Array<{ root: string; server: Server }> = [];
afterEach(async () => {
  for (const { root, server } of opened.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('group key contracts with native HTTP persistence and restart', () => {
  it('retains generated, legacy and nested group keys through native writes, reads and restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'symbi-group-contracts-'));
    const server = await createApiServer({ dataDir: root }); opened.push({ root, server });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native port');
    const base = `http://127.0.0.1:${address.port}/api/canvases/product-roadmap`;
    const entries = [
      { key: groupKey('lane', ''), label: 'other' },
      { key: groupKey('work_area', 'Developer Experience'), label: 'Developer experience' },
      { key: groupKey('purpose', ''), label: 'Other' },
      { key: 'work', label: 'Active work' },
      { key: 'lane:unlisted', label: 'unlisted' },
      { key: 'area:research/model_benchmarks', label: 'Model benchmarks' },
      { key: 'custom:release-plan/draft', label: 'Draft' },
    ];
    for (const { key, label } of entries) {
      expect(validGroupKey(key)).toBe(true); expect(groupLabel(key)).toBe(label);
      const response = await fetch(base + '/blocks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Native ' + key, content: '# Preserved group body', group: key }) });
      expect(response.status).toBe(201);
      const block = await response.json() as CanvasBlock;
      expect(block.group).toBe(key);
      const reread = await fetch(base);
      expect(reread.status).toBe(200); expect((await reread.json() as CanvasDocument).blocks.find(item => item.id === block.id)?.group).toBe(key);
    }
    const saved = await (await fetch(base)).json() as CanvasDocument;
    const fresh = new CanvasStore(root); await fresh.init();
    expect(JSON.parse(JSON.stringify(await fresh.getCanvas(saved.id, true)))).toEqual(saved);
    const created = saved.blocks.filter(block => block.title.startsWith('Native '));
    expect(created.map(block => groupLabel(block.group!))).toEqual(entries.map(entry => entry.label));
    expect(created.map(block => groupPath(block.group!))).toEqual(entries.map(entry => groupPath(entry.key)));
    const previous = created[0];
    const rejected = await fetch(base + '/blocks/' + previous.id, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group: 'custom:release/../private' }) });
    expect(rejected.status).toBe(400);
    expect(JSON.parse(JSON.stringify(await new CanvasStore(root).getCanvas(saved.id, true)))).toEqual(saved);
  });

  it.each([
    ['', ''], ['lane:', 'lane'], ['lane', 'lane'], ['unknown', 'Unknown'],
    ['custom:research/', 'Custom'], ['area:other', 'Other'], ['purpose:technical_spec', 'Technical spec'],
  ])('preserves the public display default for %j', (key, label) => {
    expect(groupLabel(key)).toBe(label);
  });

  it('retains normalization, path, validation and color defaults for public boundary inputs', () => {
    expect(normalizedGroup(undefined)).toBeUndefined(); expect(normalizedGroup('')).toBeUndefined();
    expect(groupPath('')).toEqual(['']); expect(groupPath('unlisted')).toEqual(['unlisted']);
    expect(groupAncestors('unlisted')).toEqual([]); expect(groupParent('unlisted')).toBeUndefined();
    expect(groupKey('purpose', 'A'.repeat(80))).toBe('purpose:' + 'a'.repeat(64));
    expect(groupKey('lane', 'Active Work!')).toBe('lane:active_work_');
    for (const input of [null, undefined, 4, {}, 'custom:' + 'a'.repeat(260)]) expect(validGroupKey(input)).toBe(false);
    expect(groupTone('lane:unlisted')).toBe(groupTone('lane:unlisted/subgroup'));
    expect(groupTone('reference')).toBe(2);
    expect(groupTone('custom:research/model')).toBe(groupTone('custom:research'));
  });
});
