import { describe, expect, it } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { CanvasBlock } from '../shared/types';
import { focusedEdges, groupMembers, pullNeighbors, relatedIds } from './canvas-interactions';

function block(id: string, patch: Partial<CanvasBlock> = {}): CanvasBlock {
  return { id, title: id, file: id + '.md', kind: 'markdown', content: '# ' + id,
    x: 10, y: 20, width: 320, height: 240, links: [], ...patch };
}

describe('public canvas connections and group membership', () => {

  it('normalizes legacy lane names but retains separate nested groups and stable tied reading order', () => {
    const source = [block('legacy', { group: 'work' }), block('lane', { group: 'lane:work' }),
      block('nested', { group: 'lane:work/notes' }), block('plain', { group: '' })];
    expect(groupMembers(source, 'lane:work').map(value => value.id)).toEqual(['legacy', 'lane', 'nested']);
    expect(groupMembers(source, 'lane:work/notes').map(value => value.id)).toEqual(['nested']);
    expect(groupMembers(source, '__ungrouped').map(value => value.id)).toEqual(['plain']);
    expect(groupMembers(source, 'area:missing')).toEqual([]);
  });

  it('follows incoming and outgoing links for one or two hops and retains unknown graph references', () => {
    const source = [block('a', { links: ['b', 'missing'] }), block('b', { links: ['c'] }),
      block('c', { links: ['c'] }), block('incoming', { links: ['a'] })];
    expect([...relatedIds(source, 'a', 1)]).toEqual(['a', 'b', 'missing', 'incoming']);
    expect([...relatedIds(source, 'a', 2)]).toEqual(['a', 'b', 'missing', 'incoming', 'c']);
    expect([...relatedIds(source, 'unknown', 2)]).toEqual(['unknown']);
    expect([...relatedIds([], 'unknown', 1)]).toEqual(['unknown']);
  });

  it('pulls neighbors around the selected document without moving it or unrelated documents', () => {
    const source = [block('a', { width: 400, x: 100, y: 200, links: ['b'] }), block('b', { links: ['c'] }), block('c'), block('outside')];
    expect([...pullNeighbors(source, 'missing', 1)]).toEqual([]);
    expect([...pullNeighbors([block('only')], 'only', 1)]).toEqual([]);
    expect([...pullNeighbors(source, 'a', 1)]).toEqual([['b', { x: 620, y: 200 }]]);
    const positions = pullNeighbors(source, 'a', 2);
    expect(positions.get('b')).toEqual({ x: 620, y: 200 });
    expect(positions.get('c')?.x).toBe(-420); expect(positions.get('c')?.y).toBeCloseTo(200);
    expect(positions.has('a')).toBe(false); expect(positions.has('outside')).toBe(false);
  });

  it('emphasizes only edges whose two endpoints are focused and retains existing style properties', () => {
    const edges: Edge[] = [{ id: 'ab', source: 'a', target: 'b', style: { stroke: 'teal', strokeWidth: 1 } },
      { id: 'bc', source: 'b', target: 'c' }, { id: 'ba', source: 'b', target: 'a' }, { id: 'outside', source: 'c', target: 'a' }];
    const before = structuredClone(edges);
    expect(focusedEdges(edges, new Set(['a', 'b']))).toEqual([
      { ...edges[0], style: { stroke: 'teal', strokeWidth: 2.5, opacity: .85 } },
      { ...edges[2], style: { strokeWidth: 2.5, opacity: .85 } },
    ]);
    expect(focusedEdges(edges, new Set())).toEqual([]); expect(edges).toEqual(before);
  });
});
