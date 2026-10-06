import type { AnswerCanvasTurn, ResearchLayout } from '../shared/answer-canvas';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { isHtmlDocument } from '../shared/file-transfer';
import { markdownForResearchBlock, researchGraph, type ResearchBlock, type ResearchEdge } from './research-canvas';

export type ResearchBlockChange = Partial<Pick<ResearchBlock, 'title' | 'content' | 'type' | 'kind' | 'x' | 'y' | 'width' | 'height' | 'group' | 'tags'>>;
export type ResearchCanvasEdits = {
  added: ResearchBlock[];
  changed: Record<string, ResearchBlockChange>;
  deleted: string[];
  addedEdges: ResearchEdge[];
  deletedEdges: string[];
};

export const emptyResearchEdits = (): ResearchCanvasEdits => ({
  added: [], changed: {}, deleted: [], addedEdges: [], deletedEdges: [],
});

export const researchEdgeKey = (edge: ResearchEdge) => `${edge.source}\u0000${edge.target}`;

export function savedResearchContent(block: ResearchBlock): string {
  return ((block.kind && block.kind !== 'markdown') || isHtmlDocument(block.content)) ? block.content : block.markdown;
}

export function patchResearchBlock(edits: ResearchCanvasEdits, graph: ReturnType<typeof editedResearchGraph>,
  blockId: string, patch: Omit<Partial<CanvasBlock>, 'group'> & { group?: string | null }): ResearchCanvasEdits {
  const fields = ['title', 'content', 'kind', 'x', 'y', 'width', 'height', 'group', 'tags'] as const;
  const change = { ...edits.changed[blockId] };
  for (const field of fields) if (patch[field] !== undefined) Object.assign(change, { [field]: patch[field] });
  const next = { ...edits, changed: { ...edits.changed, [blockId]: change } };
  if (!patch.links) return next;
  const desired = new Set(patch.links.filter(id => id !== blockId && graph.blocks.some(block => block.id === id)));
  const current = graph.edges.filter(edge => edge.source === blockId);
  const removed = current.filter(edge => !desired.has(edge.target)).map(researchEdgeKey);
  const added = [...desired].filter(id => !current.some(edge => edge.target === id))
    .map(target => ({ source: blockId, target, label: 'related' }));
  return { ...next,
    addedEdges: [...edits.addedEdges.filter(edge => !removed.includes(researchEdgeKey(edge))), ...added],
    deletedEdges: [...new Set([...edits.deletedEdges, ...removed])].filter(key => !added.some(edge => researchEdgeKey(edge) === key)),
  };
}

export function editedResearchGraph(turns: AnswerCanvasTurn[], layout: ResearchLayout, edits: ResearchCanvasEdits) {
  const base = researchGraph(turns, layout);
  const removed = new Set(edits.deleted);
  const blocks = [...base.blocks, ...edits.added].filter(block => !removed.has(block.id)).map(block => {
    const updated = { ...block, ...edits.changed[block.id] };
    return { ...updated, markdown: markdownForResearchBlock(updated) };
  });
  const known = new Set(blocks.map(block => block.id));
  const deletedEdges = new Set(edits.deletedEdges);
  const edges = [...base.edges, ...edits.addedEdges].filter(edge => known.has(edge.source) && known.has(edge.target)
    && !deletedEdges.has(researchEdgeKey(edge)));
  return { blocks, edges: [...new Map(edges.map(edge => [researchEdgeKey(edge), edge])).values()] };
}

export function researchCanvasDocument(turns: AnswerCanvasTurn[], layout: ResearchLayout, edits: ResearchCanvasEdits): CanvasDocument {
  const graph = editedResearchGraph(turns, layout, edits);
  return { id: 'session-research', workspaceId: 'session', name: `Research · ${turns[0]?.query ?? 'Untitled'}`,
    blocks: graph.blocks.map((block, index): CanvasBlock => ({
      id: block.id, title: block.title, file: `Temporary · ${String(index + 1).padStart(2, '0')}.md`,
      kind: block.kind ?? 'markdown', content: block.content, x: block.x, y: block.y,
      width: block.width ?? 400, height: block.height ?? 290,
      group: block.group ?? undefined, tags: block.tags ?? [], purpose: block.type,
      links: graph.edges.filter(edge => edge.source === block.id).map(edge => edge.target),
      crossLinks: block.sources.map(source => ({ canvasId: source.canvasId, blockId: source.blockId, relation: 'related' })),
    })) };
}

export function exportEditedResearchMarkdown(turns: AnswerCanvasTurn[], layout: ResearchLayout, edits: ResearchCanvasEdits): string {
  const graph = editedResearchGraph(turns, layout, edits);
  const connections = graph.edges.length ? `\n## Connections\n${graph.edges.map(edge => {
    // editedResearchGraph filters both endpoints against the surviving blocks.
    const from = graph.blocks.find(block => block.id === edge.source)!.title;
    const to = graph.blocks.find(block => block.id === edge.target)!.title;
    return `- ${from} → ${to} (${edge.label})`;
  }).join('\n')}\n` : '';
  return `# Research canvas: ${turns[0]?.query ?? 'Untitled'}\n\nLayout: ${layout}\n\n${graph.blocks.map(block => block.markdown).join('\n---\n\n')}${connections}`;
}
