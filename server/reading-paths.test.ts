import { describe, expect, it } from 'vitest';
import type { CanvasBlock } from '../shared/types.js';
import type { InsightReport } from '../shared/insights.js';
import { buildReadingPaths } from './reading-paths.js';

function block(id: string, group = 'area:engineering', links: string[] = [], linkTypes: CanvasBlock['linkTypes'] = {}): CanvasBlock {
  return { id, title: `Document ${id}`, group, links, linkTypes, content: `# ${id}`, file: `docs/${id}.md`,
    kind: 'markdown', x: 0, y: 0, width: 400, height: 320 };
}

function report(scores: Record<string, number>, lanes: Record<string, 'overview' | 'work' | 'reference' | 'followup'> = {}): Pick<InsightReport, 'readingOrder' | 'classification'> {
  return { readingOrder: Object.entries(scores).map(([blockId, score]) => ({ blockId, title: `Document ${blockId}`, score, confidence: 0.9 })),
    classification: Object.entries(lanes).map(([blockId, lane]) => ({ blockId, title: `Document ${blockId}`, lane })) };
}

describe('named reading paths', () => {
  it('honors prerequisite and decision links before expected reading order', () => {
    const blocks = [block('a', 'area:engineering', ['b'], { b: 'prerequisite' }),
      block('b', 'area:engineering', ['c'], { c: 'decision_for' }), block('c'), block('d')];
    const paths = buildReadingPaths(blocks, report({ d: 0.1, b: 0.2, a: 0.8, c: 0.9 }), 'work_area');
    expect(paths).toEqual([{ id: 'area:engineering', name: 'Engineering', blockIds: ['d', 'a', 'b', 'c'] }]);
  });

  it('builds one named path per group and uses lane priority to break equal scores', () => {
    const blocks = [block('work', 'area:engineering'), block('overview', 'area:engineering'),
      block('sales', 'area:sales')];
    const paths = buildReadingPaths(blocks, report({ work: 0.5, overview: 0.5, sales: 0.9 },
      { work: 'work', overview: 'overview' }), 'work_area');
    expect(paths).toEqual([
      { id: 'area:engineering', name: 'Engineering', blockIds: ['overview', 'work'] },
      { id: 'area:sales', name: 'Sales', blockIds: ['sales'] },
    ]);
  });

  it('ignores untyped links and archived documents and breaks saved cycles deterministically', () => {
    const first = block('a', 'area:engineering', ['b'], { b: 'prerequisite' });
    const second = block('b', 'area:engineering', ['a', 'c'], { a: 'decision_for' });
    const archived = { ...block('c'), archived: true };
    const paths = buildReadingPaths([first, second, archived], report({ a: 0.8, b: 0.2, c: 0.1 }), 'work_area');
    expect(paths[0].blockIds).toEqual(['b', 'a']);
    const untyped = buildReadingPaths([block('a', 'area:engineering', ['b']), block('b')], report({ a: 0.8, b: 0.2 }), 'work_area');
    expect(untyped[0].blockIds).toEqual(['b', 'a']);
  });

  it('uses lane groups when requested', () => {
    const blocks = [block('overview', 'lane:overview'), block('work', 'lane:work')];
    expect(buildReadingPaths(blocks, report({ overview: 0.4, work: 0.6 }), 'lane').map(path => path.id))
      .toEqual(['lane:overview', 'lane:work']);
  });
});
