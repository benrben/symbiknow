import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CanvasBlock } from '../shared/types.js';
import { getSimilarityIndex, shingleOverlap, SimilarityIndex, tokenize } from './similarity.js';
import { CanvasStore } from './storage.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function block(id: string, content = 'gateway endpoint credentials validate signatures durable delivery', patch: Partial<CanvasBlock> = {}): CanvasBlock {
  return { id, title: '', content, file: id + '.md', kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [], ...patch };
}

describe('public similarity index contracts', () => {
  it('normalizes accented and full-width text, drops short words and stop words, and handles an empty vocabulary', () => {
    expect(tokenize('Café ＡＢＣ Kelvin THE and with A1 xy')).toEqual(['cafe', 'abc', 'kelvin']);
    expect(tokenize('12345 👾 !!!')).toEqual([]);
    expect(tokenize('')).toEqual([]);
    expect(shingleOverlap('alpha bravo charlie delta echo', '---\nformat: html\n---\n<p>alpha bravo charlie delta echo</p>')).toBe(1);
    expect(shingleOverlap('alpha bravo charlie delta echo', '')).toBe(0);
    expect(shingleOverlap('', 'alpha bravo charlie delta echo')).toBe(0);
  });

  it('uses logarithmic term frequency and stable lexical ordering for exact cosine ties', () => {
    const index = new SimilarityIndex();
    index.syncCanvas('z-canvas', [block('source', 'alpha alpha bravo'), block('z-peer', 'alpha bravo bravo')]);
    index.syncCanvas('a-canvas', [block('b-peer', 'alpha bravo bravo'), block('a-peer', 'alpha bravo bravo')]);
    const result = index.neighbors('source', 10, { sameCanvas: true, crossCanvas: true });
    expect(result.map(item => [item.canvasId, item.blockId])).toEqual([
      ['a-canvas', 'a-peer'], ['a-canvas', 'b-peer'], ['z-canvas', 'z-peer'],
    ]);
    expect(result.every(item => Math.abs(item.score - .8757475036978677) < 1e-12)).toBe(true);
    expect(index.neighbors('source', 1)).toEqual([result[2]]);
    expect(index.neighbors('source', 10, { sameCanvas: false, crossCanvas: true })).toEqual(result.slice(0, 2));
    expect(index.neighbors('source', 10, { sameCanvas: false, crossCanvas: false })).toEqual([]);
  });

  it('returns no neighbors for missing or empty sources, nonpositive caps, or unrelated candidates', () => {
    const index = new SimilarityIndex();
    expect(index.neighbors('missing', 4)).toEqual([]);
    index.syncCanvas('one', [block('empty', 'the and for'), block('source'), block('unrelated', 'culinary roasted vegetables aromatic recipes')]);
    expect(index.neighbors('empty', 4)).toEqual([]);
    expect(index.neighbors('source', 0)).toEqual([]);
    expect(index.neighbors('source', -1)).toEqual([]);
    expect(index.neighbors('source', 4)).toEqual([]);
    expect(index.shingleOverlap('missing', 'source')).toBe(0);
    expect(index.shingleOverlap('source', 'missing')).toBe(0);
  });

  it('retains fingerprints for metadata-only changes and reindexes changed titles, raw content, hashes and canvas membership', () => {
    const index = new SimilarityIndex(); const source = block('source'); const peer = block('peer');
    expect(index.upsert('one', source)).toBe(true); expect(index.upsert('one', peer)).toBe(true);
    expect(index.neighbors('source', 1)[0].score).toBeCloseTo(1);
    expect(index.upsert('one', { ...source, x: 200, tags: ['saved'] })).toBe(false);
    expect(index.upsert('one', { ...source, title: 'Gateway' })).toBe(true);
    expect(index.upsert('one', { ...source, content: 'roasted aromatic vegetables recipes culinary preparation' })).toBe(true);
    expect(index.neighbors('source', 1)).toEqual([]);
    expect(index.upsert('one', { ...peer, contentHash: 'explicit-hash' })).toBe(true);
    expect(index.upsert('one', { ...peer, contentHash: 'explicit-hash' })).toBe(false);
    expect(index.upsert('two', { ...peer, contentHash: 'explicit-hash' })).toBe(true);
    expect(index.remove('missing')).toBe(false); expect(index.remove('source')).toBe(true);
    expect(index.remove('peer')).toBe(true); expect(index.remove('peer')).toBe(false);
    expect(index.upsert('one', block('source'))).toBe(true); expect(index.upsert('one', block('peer'))).toBe(true);
    expect(index.neighbors('source', 1)[0].score).toBeCloseTo(1);
  });

  it('syncs only the selected canvas and clears its members without removing another canvas', () => {
    const index = new SimilarityIndex();
    index.syncCanvas('one', [block('source'), block('peer')]); index.syncCanvas('two', [block('cross')]);
    index.syncCanvas('one', [block('source')]);
    expect(index.neighbors('source', 2)).toEqual([]);
    expect(index.neighbors('source', 2, { crossCanvas: true }).map(item => item.blockId)).toEqual(['cross']);
    index.clearCanvas('one'); expect(index.neighbors('source', 2, { crossCanvas: true })).toEqual([]);
    index.upsert('two', block('new-peer'));
    expect(index.neighbors('cross', 1).map(item => item.blockId)).toEqual(['new-peer']);
    expect(index.shingleOverlap('cross', 'new-peer')).toBe(1);
  });

  it('keeps genuine store indexes isolated, updates persisted edits and moves, and reproduces neighbors after restart', async () => {
    for (let index = 0; index < 2; index++) roots.push(await mkdtemp(path.join(os.tmpdir(), 'symbi-similarity-native-')));
    const first = new CanvasStore(roots[0]); const second = new CanvasStore(roots[1]);
    await first.init(); await second.init();
    const canvas = await first.createCanvas('acme-team', { name: 'Index source' });
    const other = await first.createCanvas('acme-team', { name: 'Index destination' });
    const remote = await second.createCanvas('acme-team', { name: 'Other store' });
    const content = 'gateway endpoint credentials validate signatures durable delivery';
    const source = await first.createBlock(canvas.id, { title: 'Alpha', content });
    const peer = await first.createBlock(canvas.id, { title: 'Bravo', content });
    const cross = await first.createBlock(other.id, { title: 'Charlie', content });
    const isolated = await second.createBlock(remote.id, { title: 'Delta', content });
    await first.getCanvas(canvas.id); await first.getCanvas(other.id); await second.getCanvas(remote.id);
    const localIndex = first.similarityIndex('acme-team');
    expect(getSimilarityIndex(roots[0] + ':acme-team')).toBe(localIndex);
    expect(localIndex.neighbors(source.id, 2).map(item => item.blockId)).toEqual([peer.id]);
    expect(localIndex.neighbors(source.id, 3, { crossCanvas: true }).map(item => item.blockId).sort()).toEqual([peer.id, cross.id].sort());
    expect(second.similarityIndex('acme-team').neighbors(source.id, 3, { crossCanvas: true })).toEqual([]);
    expect(localIndex.neighbors(isolated.id, 3, { crossCanvas: true })).toEqual([]);
    await first.updateBlock(canvas.id, peer.id, { content: 'culinary roasted vegetables aromatic recipes' });
    await first.getCanvas(canvas.id);
    expect(localIndex.neighbors(source.id, 2)).toEqual([]);
    await first.moveBlockToCanvas(canvas.id, source.id, other.id, 'Native move');
    await first.getCanvas(canvas.id); await first.getCanvas(other.id);
    expect(localIndex.neighbors(source.id, 2).map(item => [item.canvasId, item.blockId])).toEqual([[other.id, cross.id]]);
    const reopened = new CanvasStore(roots[0]); await reopened.init();
    const saved = await reopened.getCanvas(other.id); await reopened.getCanvas(canvas.id);
    expect(reopened.similarityIndex('acme-team').neighbors(source.id, 2)).toEqual(localIndex.neighbors(source.id, 2));
    expect(saved.blocks.find(item => item.id === source.id)?.content).toBe(content);
    expect(await readFile(path.join(roots[0], source.file), 'utf8')).toContain(content);
    await reopened.deleteCanvas(other.id);
    expect(localIndex.neighbors(source.id, 2, { crossCanvas: true })).toEqual([]);
    expect(await second.getCanvas(remote.id)).toMatchObject({ blocks: [{ id: isolated.id, content }] });
  });
});
