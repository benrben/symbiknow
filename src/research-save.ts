import type { CanvasBlock, CanvasDocument, WorkspaceSummary } from '../shared/types';
import { api } from './api';
import { savedResearchContent, type editedResearchGraph } from './research-edits';

type ResearchGraph = ReturnType<typeof editedResearchGraph>;
type ResearchSave = { workspaceId: string; name: string; graph: ResearchGraph; workspaces: WorkspaceSummary[] };

async function availableResearchSources(save: ResearchSave) {
  const canvasIds = new Set(save.workspaces.find(workspace => workspace.id === save.workspaceId)?.canvases.map(canvas => canvas.id) ?? []);
  const citedIds = [...new Set(save.graph.blocks.flatMap(block => block.sources.map(source => source.canvasId)))].filter(id => canvasIds.has(id));
  const cited = await Promise.allSettled(citedIds.map(id => api<CanvasDocument>(`/canvases/${encodeURIComponent(id)}`)));
  return new Set(cited.flatMap((result, index) => result.status === 'fulfilled'
    ? result.value.blocks.map(block => `${citedIds[index]}:${block.id}`) : []));
}

export async function persistResearchCanvas(save: ResearchSave): Promise<CanvasDocument> {
  const created = await api<CanvasDocument>(`/workspaces/${encodeURIComponent(save.workspaceId)}/canvases`, {
    method: 'POST', body: JSON.stringify({ name: save.name }),
  });
  try {
    const availableSources = await availableResearchSources(save);
    const savedBlocks = await saveResearchBlocks(created.id, save.graph);
    await saveResearchLinks(created.id, save.graph, savedBlocks, availableSources);
  } catch (reason) {
    await removeIncompleteResearch(created.id, reason);
    throw reason;
  }
  return created;
}

async function removeIncompleteResearch(canvasId: string, originalFailure: unknown): Promise<void> {
  try { await api(`/canvases/${encodeURIComponent(canvasId)}`, { method: 'DELETE' }); }
  catch (cleanupFailure) {
    console.warn('Incomplete research canvas could not be removed.', cleanupFailure);
    throw new Error(`${String(originalFailure)}. Incomplete canvas ${canvasId} could not be removed. Delete it before retrying.`, { cause: originalFailure });
  }
}

/** A completed write remains successful when a secondary navigation refresh fails. */
export async function refreshResearchWorkspaces(created: CanvasDocument) {
  try { return await api<WorkspaceSummary[]>('/workspaces'); }
  catch (reason) {
    console.warn('Research was saved, but workspace refresh failed.', reason);
    return (current: WorkspaceSummary[]) => current.map(workspace => workspace.id === created.workspaceId
      ? { ...workspace, canvases: [...workspace.canvases, { id: created.id, name: created.name }] } : workspace);
  }
}

async function saveResearchBlocks(canvasId: string, graph: ResearchGraph) {
  const savedBlocks = new Map<string, string>();
  for (const block of graph.blocks) {
    const saved = await api<CanvasBlock>(`/canvases/${encodeURIComponent(canvasId)}/blocks`, {
      method: 'POST', body: JSON.stringify({ title: block.title, content: savedResearchContent(block),
        kind: block.kind ?? 'markdown', x: block.x, y: block.y, width: block.width, height: block.height,
        group: block.group, tags: block.tags }),
    });
    savedBlocks.set(block.id, saved.id);
  }
  return savedBlocks;
}

async function saveResearchLinks(canvasId: string, graph: ResearchGraph, savedBlocks: Map<string, string>, availableSources: Set<string>) {
  for (const block of graph.blocks) {
    const links = graph.edges.filter(edge => edge.source === block.id).map(edge => savedBlocks.get(edge.target)).filter((id): id is string => Boolean(id));
    const crossLinks = block.sources.filter(source => availableSources.has(`${source.canvasId}:${source.blockId}`))
      .map(source => ({ canvasId: source.canvasId, blockId: source.blockId, relation: 'related' }));
    if (hasResearchProperties(block, links, crossLinks)) await api(`/canvases/${encodeURIComponent(canvasId)}/blocks/${encodeURIComponent(savedBlocks.get(block.id)!)}`, {
      method: 'PUT', body: JSON.stringify({ links, crossLinks, width: block.width, height: block.height }),
    });
  }
}

function hasResearchProperties(block: ResearchGraph['blocks'][number], links: string[], crossLinks: unknown[]) {
  return Boolean(links.length || crossLinks.length || block.width !== undefined || block.height !== undefined);
}
