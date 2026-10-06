import { describe, expect, it } from 'vitest';
import type { AnswerCanvasTurn, ResearchCanvasBlock, ResearchLayout } from '../shared/answer-canvas';
import { exportResearchMarkdown, researchGraph, researchMarkdown } from './research-canvas';

const source = { canvasId: 'source-canvas', canvasName: 'Source canvas', blockId: 'evidence', title: 'Evidence', excerpt: 'Recorded facts', relevance: 1 };
function block(id: string, content = 'Context'): ResearchCanvasBlock { return { id, title: id, content, type: 'text', sourceIds: [] }; }
function turn(blocks: ResearchCanvasBlock[], edges: Array<{ from: string; to: string; label?: string }> = []): AnswerCanvasTurn {
  return { id: 1, query: 'Map the evidence', answer: 'Fallback answer', sources: [source], status: 'complete', patch: { query: 'Map the evidence', blocks, edges } };
}

describe('research graph public boundaries before structural extraction', () => {
  it.each([
    ['roadmap', [[0, 0, undefined], [520, 0, undefined], [0, 570, undefined]]],
    ['mindmap', [[0, 145, undefined], [0, 535, undefined], [0, 960, undefined]]],
    ['architecture', [[0, 0, 'Context'], [520, 0, 'Context'], [0, 570, 'Context']]],
    ['kanban', [[520, 0, 'Evidence'], [520, 390, 'Evidence'], [520, 780, 'Evidence']]],
  ] as const)('preserves exact two-turn positions and lanes for %s', (layout, positions) => {
    const first = turn([block('A'), block('B')]); const next = { ...turn([block('C')]), id: 2 };
    expect(researchGraph([first, next], layout).blocks.map(value => [value.x, value.y, value.lane])).toEqual(positions);
  });

  it('retains cyclic and invalid-edge ordering while exporting only edges with known endpoints', () => {
    const input = turn([block('C'), block('A'), block('B')], [
      { from: 'A', to: 'B' }, { from: 'B', to: 'A', label: 'cycle' }, { from: 'A', to: 'A', label: 'self' },
      { from: 'missing', to: 'B' }, { from: 'A', to: 'missing' },
    ]);
    const graph = researchGraph([input], 'architecture');
    expect(graph.blocks.map(value => value.id)).toEqual(['1:C', '1:A', '1:B']);
    expect(graph.edges).toEqual([{ source: '1:A', target: '1:B', label: 'connects' }, { source: '1:B', target: '1:A', label: 'cycle' }, { source: '1:A', target: '1:A', label: 'self' }]);
    expect(exportResearchMarkdown([input], 'architecture')).toContain('- A → B (connects)');
  });

  it('uses the most recent shared evidence without conflating equal document IDs on different canvases', () => {
    const one = turn([{ ...block('one'), sourceIds: ['source-canvas:evidence'] }]);
    const two = { ...turn([{ ...block('two'), sourceIds: ['other-canvas:evidence'] }]), id: 2, sources: [{ ...source, canvasId: 'other-canvas' }] };
    const three = { ...turn([{ ...block('three'), sourceIds: ['source-canvas:evidence'] }]), id: 3 };
    expect(researchGraph([one, two, three], 'roadmap').edges).toEqual([{ source: '1:one', target: '3:three', label: 'shared evidence' }]);
  });

  it('waits for every incoming edge before placing a joined dependency', () => {
    const input = turn([block('Joined'), block('A'), block('B')], [{ from: 'A', to: 'Joined' }, { from: 'B', to: 'Joined' }]);
    const graph = researchGraph([input], 'mindmap');
    expect(graph.blocks.map(value => value.title)).toEqual(['A', 'B', 'Joined']);
    expect(graph.blocks.map(value => value.x)).toEqual([0, 0, 520]);
  });

  it('classifies lanes consistently and keeps explicit, unknown and differently cased lanes', () => {
    const input = turn([block('Risk', 'Unknown dependency'), block('Evidence', 'Recorded facts'), block('Task', 'Fix launch'),
      { ...block('Explicit'), lane: 'nExT AcTiOnS' }, { ...block('Unknown lane', 'Fix it'), lane: 'Custom' }]);
    expect(researchGraph([input], 'kanban').blocks.map(value => value.lane)).toEqual(['Open questions', 'Evidence', 'Next actions', 'Next actions', 'Open questions']);
    const architecture = turn([block('Context'), block('Service', 'Component diagram'), block('Outcome', 'Decision'), { ...block('Explicit'), lane: 'Custom' }]);
    expect(researchGraph([architecture], 'architecture').blocks.map(value => value.lane)).toEqual(['Context', 'System', 'Outcome', 'Custom']);
  });

  it('caps deep mindmap columns while keeping all blocks', () => {
    const blocks = Array.from({ length: 7 }, (_, index) => block(String(index)));
    blocks[6].verification = { status: 'unsupported', checkedClaims: 1, totalClaims: 2 };
    const edges = blocks.slice(1).map((value, index) => ({ from: String(index), to: value.id }));
    const graph = researchGraph([turn(blocks, edges)], 'mindmap');
    expect(graph.blocks.map(value => value.x)).toEqual([0, 520, 1040, 1560, 2080, 2080, 2080]);
    expect(graph.blocks.slice(4).map(value => value.y)).toEqual([0, 390, 780]);
  });

  it('normalizes explicit HTML kinds and preserves citation filtering and Markdown exports', () => {
    const input = turn([{ ...block('Interactive', '<h1>Interactive</h1>'), kind: 'html', sourceIds: ['source-canvas:evidence', 'missing:source'] }]);
    const graph = researchGraph([input], 'architecture'); expect(graph.blocks[0]).toMatchObject({ kind: 'markdown', sources: [source] });
    expect(graph.blocks[0].content).toContain('<h1>Interactive</h1>'); expect(graph.blocks[0].markdown).toContain('## Sources\n1. **Evidence**');
    expect(researchMarkdown(input)).toContain('<h1>Interactive</h1>');
  });

  it('keeps fallbacks for empty, unstructured, stopped and working turns', () => {
    const empty = turn([]); empty.answer = ''; empty.status = 'stopped';
    expect(researchGraph([empty], 'roadmap').blocks[0].content).toBe('Research in progress.');
    expect(researchMarkdown(empty)).toContain('Research in progress.');
    const working = { ...turn([block('Partial')]), status: 'working' as const };
    expect(researchGraph([working], 'roadmap').blocks[0].title).toBe('Partial');
    expect(exportResearchMarkdown([], 'roadmap')).toBe('# Research canvas: Untitled\n\nLayout: roadmap\n\n');
  });

  it('retains zero placement for an unsupported runtime layout without dropping authored lane information', () => {
    const input = turn([{ ...block('A'), lane: 'Authored' }, block('B')]);
    expect(researchGraph([input], 'unsupported' as ResearchLayout).blocks.map(value => [value.x, value.y, value.lane])).toEqual([[0, 0, 'Authored'], [0, 0, undefined]]);
  });
});
