import { describe, expect, it } from 'vitest';
import { exportResearchMarkdown, researchGraph, researchMarkdown } from './research-canvas';
import { patchFromMarkdown } from '../shared/research-patch';
import type { AnswerCanvasTurn, ResearchCanvasPatch } from '../shared/answer-canvas';

const source = { canvasId: 'planning', canvasName: 'Planning', blockId: 'qa', title: 'QA report', excerpt: 'Two failures', relevance: 1 };
const patch: ResearchCanvasPatch = { query: 'What blocks launch?', layout: 'architecture', blocks: [
  { id: 'finding', type: 'text', title: 'Key finding', content: 'Two tests failed.', sourceIds: ['planning:qa'] },
  { id: 'flow', type: 'diagram', title: 'Release flow', content: '```mermaid\nflowchart LR\nQA-->Release\n```', sourceIds: ['planning:qa'] },
  { id: 'actions', type: 'task', title: 'Next actions', content: '- [ ] Fix checkout\n- [ ] Re-run QA', sourceIds: [] },
], edges: [{ from: 'finding', to: 'flow', label: 'explains' }, { from: 'flow', to: 'actions', label: 'unblocks' }] };
const turns: AnswerCanvasTurn[] = [
  { id: 2, query: patch.query, answer: 'Two tests failed.', status: 'complete', selection: 'jev', sources: [source], patch },
  { id: 4, query: 'What next?', answer: 'Re-run QA.', status: 'complete', selection: 'jev', sources: [source], patch: {
    query: 'What next?', blocks: [{ id: 'decision', type: 'text', title: 'Decision', content: 'Re-run QA.', sourceIds: ['planning:qa'] }], edges: [],
  } },
];

describe('session research canvas', () => {
  it('puts agent text, diagrams, tasks, and Jev citations inside Markdown blocks', () => {
    const markdown = researchMarkdown(turns[0]);
    expect(markdown).toContain('Two tests failed.');
    expect(markdown).toContain('```mermaid');
    expect(markdown).toContain('- [ ] Fix checkout');
    expect(markdown).toContain('## Sources\n1. **QA report** — Planning');
    expect(exportResearchMarkdown(turns, 'architecture')).toContain('Layout: architecture');
  });

  it('keeps multiple blocks per answer and connects follow-ups across four layouts', () => {
    for (const layout of ['roadmap', 'kanban', 'architecture', 'mindmap'] as const) {
      const graph = researchGraph(turns, layout);
      expect(graph.blocks).toHaveLength(4);
      expect(graph.blocks.map(block => block.type)).toEqual(['text', 'diagram', 'task', 'text']);
      expect(graph.edges).toContainEqual({ source: '2:flow', target: '2:actions', label: 'unblocks' });
      expect(graph.edges).toContainEqual({ source: '2:flow', target: '4:decision', label: 'shared evidence' });
      expect(new Set(graph.blocks.map(block => `${block.x}:${block.y}`)).size).toBe(4);
    }
  });

  it('places a connected answer by its dependency edges even when blocks arrive out of order', () => {
    const unordered: AnswerCanvasTurn = { ...turns[0], patch: { ...patch,
      blocks: [patch.blocks[2], patch.blocks[0], patch.blocks[1]],
    } };
    const graph = researchGraph([unordered], 'architecture');
    expect(graph.blocks.map(block => block.title)).toEqual(['Key finding', 'Release flow', 'Next actions']);
    expect(graph.blocks[0].x).toBe(0);
    expect(graph.blocks[1].x).toBe(520);
    expect(graph.blocks[2].x).toBe(520);
    expect(graph.blocks[2].y).toBeGreaterThan(graph.blocks[1].y);
  });

  it('keeps full-size cards separated across answers in every layout', () => {
    const next = { ...turns[1], patch: { ...turns[1].patch!, blocks: [
      { id: 'context', type: 'text' as const, title: 'Context', content: 'First.', sourceIds: [] },
      { id: 'system', type: 'text' as const, title: 'System', content: 'Second.', sourceIds: [] },
      { id: 'outcome', type: 'text' as const, title: 'Outcome', content: 'Third.', sourceIds: [] },
      { id: 'followup', type: 'text' as const, title: 'Follow-up', content: 'Fourth.', sourceIds: [] },
    ] } };
    for (const layout of ['roadmap', 'kanban', 'architecture', 'mindmap'] as const) {
      const blocks = researchGraph([turns[0], next], layout).blocks;
      for (const [index, left] of blocks.entries()) {
        for (const right of blocks.slice(index + 1)) {
          const horizontalGap = Math.max(right.x - (left.x + 400), left.x - (right.x + 400));
          const verticalGap = Math.max(right.y - (left.y + 290), left.y - (right.y + 290));
          expect(Math.max(horizontalGap, verticalGap), `${layout}: ${left.id} and ${right.id}`).toBeGreaterThanOrEqual(60);
        }
      }
    }
  });

  it('leaves unrelated follow-up topics unconnected', () => {
    const unrelated = { ...turns[1], sources: [{ ...source, blockId: 'other' }], patch: { ...turns[1].patch!,
      blocks: [{ id: 'decision', type: 'text' as const, title: 'Another decision', content: 'Different source.', sourceIds: ['planning:other'] }],
    } };
    const graph = researchGraph([turns[0], unrelated], 'architecture');
    expect(graph.edges.some(edge => edge.target === '4:decision')).toBe(false);
  });

  it('does not invent evidence blocks or causal edges when the agent gives an unstructured fallback', () => {
    const fallback = patchFromMarkdown('What blocks launch?', 'Two tests failed.', [source]);
    expect(fallback.blocks).toHaveLength(1);
    expect(fallback.blocks[0].sourceIds).toEqual(['planning:qa']);
    expect(fallback.edges).toEqual([]);
  });

  it('waits for the agent drawing before placing a working answer on the canvas', () => {
    const working: AnswerCanvasTurn = { id: 8, query: 'Map launch risks', answer: 'Checking sources…', status: 'working', sources: [source] };
    expect(researchGraph([working], 'mindmap')).toEqual({ blocks: [], edges: [] });
  });
});
