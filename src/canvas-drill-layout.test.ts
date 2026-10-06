import { describe, expect, it } from 'vitest';
import type { CanvasBlock } from '../shared/types';
import { drillCamera, drillLayout, drillPosition } from './canvas-drill-layout';

function block(id: string, x: number, y: number, group?: string): CanvasBlock {
  return { id, title: id, content: '', file: `${id}.md`, kind: 'markdown', x, y, width: 400, height: 320, links: [], ...(group ? { group } : {}) };
}

describe('drillLayout', () => {
  it('packs a scattered group into a reading-order grid at the group origin', () => {
    const blocks = [block('config', 2160, 1200, 'custom:operations'), block('testing', 360, 1800, 'custom:operations'),
      block('deploy', 3000, 3200, 'custom:operations'), block('agents', 0, 1200, 'custom:ai_agents')];
    const positions = drillLayout(blocks, 'custom:operations');
    expect([...positions]).toEqual([
      ['config', { x: 360, y: 1200 }], ['testing', { x: 808, y: 1200 }], ['deploy', { x: 360, y: 1568 }],
    ]);
  });

  it('keeps nested subgroups together and includes ungrouped documents when that is the drilled group', () => {
    const nested = [block('b', 4000, 0, 'custom:launch/qa'), block('a', 0, 3000, 'custom:launch/design'), block('c', 0, 0, 'custom:launch/qa')];
    expect([...drillLayout(nested, 'custom:launch').keys()]).toEqual(['a', 'c', 'b']);
    expect([...drillLayout([block('one', 0, 0), block('two', 5000, 5000)], '__ungrouped').keys()]).toEqual(['one', 'two']);
  });

  it('leaves tidy groups, single documents, and the whole canvas as they are', () => {
    const tidy = [block('a', 0, 0, 'custom:team'), block('b', 460, 0, 'custom:team'), block('c', 0, 380, 'custom:team')];
    expect(drillLayout(tidy, 'custom:team').size).toBe(0);
    expect(drillLayout([block('solo', 0, 0, 'custom:team'), block('far', 9000, 9000, 'custom:other')], 'custom:team').size).toBe(0);
    expect(drillLayout([block('a', 0, 0), block('b', 9000, 9000)], '').size).toBe(0);
  });
});

describe('drillPosition', () => {
  const saved = block('a', 10, 20);
  const positions = new Map([['a', { x: 0, y: 0 }]]);
  it('uses the packed place until the person moves the card', () => {
    expect(drillPosition(positions, { id: 'a', position: { x: 10, y: 20 }, data: { block: saved } })).toEqual({ x: 0, y: 0 });
    expect(drillPosition(positions, { id: 'a', position: { x: 10, y: 99 }, data: { block: saved } })).toEqual({ x: 10, y: 99 });
    expect(drillPosition(positions, { id: 'a', position: { x: 99, y: 20 }, data: { block: saved } })).toEqual({ x: 99, y: 20 });
    expect(drillPosition(new Map(), { id: 'a', position: { x: 10, y: 20 }, data: { block: saved } })).toEqual({ x: 10, y: 20 });
  });
});

describe('drillCamera', () => {
  const scattered = [block('config', 2160, 1200, 'custom:operations'), block('testing', 360, 1800, 'custom:operations'),
    block('deploy', 3000, 3200, 'custom:operations')];
  const view = { width: 1000, height: 600 };

  it('centers on the packed documents and zooms out just enough to show them', () => {
    expect(drillCamera(scattered, 'custom:operations', { x: 360, y: 1200, width: 3040, height: 2320 }, view))
      .toEqual({ x: 784, y: 1544, zoom: 600 / (688 + 160) });
  });

  it('keeps a tidy group frame, its reading zoom when unmeasured, and a floor when it is huge', () => {
    const frame = { x: 0, y: 0, width: 400, height: 320 };
    expect(drillCamera([], 'custom:team', frame, view)).toEqual({ x: 200, y: 160, zoom: 0.8 });
    expect(drillCamera([], 'custom:team', frame, { width: 0, height: 0 })).toMatchObject({ zoom: 0.8 });
    expect(drillCamera([], 'custom:team', { ...frame, width: 9000 }, view)).toMatchObject({ zoom: 0.4 });
    expect(drillCamera([], 'custom:team', undefined, view)).toBeUndefined();
  });
});
