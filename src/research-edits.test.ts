import { describe, expect, it } from 'vitest';
import type { AnswerCanvasTurn } from '../shared/answer-canvas';
import { editedResearchGraph, emptyResearchEdits, patchResearchBlock, researchCanvasDocument, researchEdgeKey, savedResearchContent } from './research-edits';

const turns: AnswerCanvasTurn[] = [{ id: 1, query: 'Trust', answer: '', status: 'complete', sources: [], patch: {
  query: 'Trust', blocks: [
    { id: 'start', type: 'section', title: 'Start', content: 'Old answer', sourceIds: [] },
    { id: 'next', type: 'text', title: 'Next', content: 'Follow-up', sourceIds: [] },
  ], edges: [{ from: 'start', to: 'next', label: 'leads to' }],
} }];

describe('temporary research canvas edits', () => {
  it('keeps manual edits, positions, additions, links, and deletions over agent answers', () => {
    const base = editedResearchGraph(turns, 'roadmap', emptyResearchEdits());
    const edits = emptyResearchEdits();
    edits.changed['1:start'] = { title: 'Edited start', content: 'New answer', x: 75, y: 80 };
    edits.added = [{ ...base.blocks[0], id: 'user:note', title: 'My note', content: 'User insight', sources: [], x: 500, y: 90 }];
    edits.deleted = ['1:next'];
    edits.addedEdges = [{ source: '1:start', target: 'user:note', label: 'supports' }];
    edits.deletedEdges = [researchEdgeKey({ source: '1:start', target: '1:next', label: 'leads to' })];
    const graph = editedResearchGraph([...turns, { ...turns[0], id: 2 }], 'roadmap', edits);
    expect(graph.blocks.find(block => block.id === '1:start')).toMatchObject({ title: 'Edited start', content: 'New answer', x: 75, y: 80 });
    expect(graph.blocks.find(block => block.id === '1:start')?.markdown).toContain('New answer');
    expect(graph.blocks.some(block => block.id === '1:next')).toBe(false);
    expect(graph.blocks.find(block => block.id === 'user:note')?.markdown).toContain('User insight');
    expect(graph.edges).toContainEqual({ source: '1:start', target: 'user:note', label: 'supports' });
    expect(graph.edges.some(edge => edge.target === '1:next')).toBe(false);
  });

  it('adapts research blocks to normal canvas cards and updates the same properties', () => {
    const initial = emptyResearchEdits();
    const graph = editedResearchGraph(turns, 'roadmap', initial);
    const next = patchResearchBlock(initial, graph, '1:start', {
      title: 'Trusted start', x: 320, width: 510, group: 'custom:research', tags: ['review'],
      links: [],
    });
    const document = researchCanvasDocument(turns, 'roadmap', next);
    expect(document.blocks[0]).toMatchObject({
      id: '1:start', title: 'Trusted start', x: 320, width: 510, group: 'custom:research', tags: ['review'],
      kind: 'markdown', purpose: 'section', links: [],
    });
    expect(editedResearchGraph(turns, 'roadmap', next).edges).toHaveLength(0);
    const restored = patchResearchBlock(next, editedResearchGraph(turns, 'roadmap', next), '1:start', { links: ['1:next'] });
    expect(editedResearchGraph(turns, 'roadmap', restored).edges).toContainEqual({
      source: '1:start', target: '1:next', label: 'related',
    });
  });

  it('keeps image, HTML, slide, MDX, and website source in their native loaders', () => {
    const formats: AnswerCanvasTurn[] = [{ id: 3, query: 'Show the launch', answer: '', status: 'complete', sources: [], patch: {
      query: 'Show the launch', edges: [], blocks: [
        { id: 'image', type: 'text', kind: 'markdown', title: 'Image', content: '![Launch](https://example.com/launch.png)', sourceIds: [] },
        { id: 'html', type: 'section', kind: 'html', title: 'Page', content: '<!doctype html><html><body><h1>Launch</h1></body></html>', sourceIds: [] },
        { id: 'slides', type: 'section', kind: 'slides', title: 'Deck', content: '---\nmarp: true\n---\n# Launch', sourceIds: [] },
        { id: 'chart', type: 'diagram', kind: 'mdx', title: 'Chart', content: '<Chart title="Status" values="2,4" />', sourceIds: [] },
        { id: 'site', type: 'section', kind: 'website', title: 'Site', content: '---\ngenerator: mkdocs\nsource: sites/team-docs\n---\n# Docs', sourceIds: [] },
      ],
    } }];
    const blocks = researchCanvasDocument(formats, 'roadmap', emptyResearchEdits()).blocks;
    expect(blocks.map(block => block.kind)).toEqual(['markdown', 'markdown', 'slides', 'mdx', 'website']);
    expect(blocks[0].content).toContain('![Launch]');
    expect(blocks[1].content).toMatch(/^---\nformat: html\n---\n<!doctype html>/u);
    expect(blocks[2].content).toContain('marp: true');
    expect(blocks[3].content).toContain('<Chart');
    expect(blocks[4].content).toContain('generator: mkdocs');
    const graph = editedResearchGraph(formats, 'roadmap', emptyResearchEdits());
    expect(savedResearchContent(graph.blocks[0])).toContain('# Image');
    expect(savedResearchContent(graph.blocks[1])).toBe(blocks[1].content);
    expect(savedResearchContent(graph.blocks[2])).toBe(blocks[2].content);
    expect(savedResearchContent(graph.blocks[3])).toBe(blocks[3].content);
    expect(savedResearchContent(graph.blocks[4])).toBe(blocks[4].content);
  });
});
