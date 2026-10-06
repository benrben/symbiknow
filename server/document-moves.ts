import type { CanvasBlock, CanvasDocument, CanvasTask, CrossLink, LinkRelation } from '../shared/types.js';
import { commentedTask, newTask } from './coordination.js';
import { ApiError } from './errors.js';

function uniqueCrossLinks(links: CrossLink[]): CrossLink[] {
  const unique = [...new Map(links.map(link => [`${link.canvasId}:${link.blockId}`, link])).values()];
  if (unique.length > 20) throw new ApiError(409, 'Moving this document would exceed the cross-canvas link limit. Review its links first.');
  return unique;
}

function localizedLinkTypes(previous: CanvasBlock['linkTypes'], local: CrossLink[], links: string[]): Record<string, LinkRelation> {
  const linkTypes = { ...previous };
  for (const link of local) if (link.relation && links.includes(link.blockId)) linkTypes[link.blockId] = link.relation;
  return linkTypes;
}

/** Convert cross links that now share a canvas into ordinary typed links. */
function localize(block: CanvasBlock, canvasId: string): CanvasBlock {
  const saved = block.crossLinks ?? [];
  const local = saved.filter(link => link.canvasId === canvasId);
  const links = [...new Set([...block.links, ...local.map(link => link.blockId)])].filter(id => id !== block.id);
  const linkTypes = localizedLinkTypes(block.linkTypes, local, links);
  const crossLinks = uniqueCrossLinks(saved.filter(link => link.canvasId !== canvasId));
  return { ...block, links, linkTypes: Object.keys(linkTypes).length ? linkTypes : undefined,
    crossLinks: crossLinks.length ? crossLinks : undefined };
}

function retarget(block: CanvasBlock, sourceId: string, targetId: string, blockId: string): CanvasBlock {
  const crossLinks = block.crossLinks?.map(link => link.canvasId === sourceId && link.blockId === blockId
    ? { ...link, canvasId: targetId } : link);
  return { ...block, crossLinks };
}

function sourceBlock(block: CanvasBlock, movedId: string, targetId: string): CanvasBlock {
  if (!block.links.includes(movedId)) return block;
  const relation = block.linkTypes?.[movedId];
  const linkTypes = { ...block.linkTypes };
  delete linkTypes[movedId];
  return { ...block, links: block.links.filter(id => id !== movedId),
    linkTypes: Object.keys(linkTypes).length ? linkTypes : undefined,
    crossLinks: uniqueCrossLinks([...(block.crossLinks ?? []), { canvasId: targetId, blockId: movedId,
      ...(relation ? { relation } : {}) }]) };
}

export function movedCanvasDocuments(canvases: CanvasDocument[], sourceId: string, targetId: string,
  moved: CanvasBlock): CanvasDocument[] {
  const outgoing: CrossLink[] = moved.links.map(blockId => ({ canvasId: sourceId, blockId,
    ...(moved.linkTypes?.[blockId] ? { relation: moved.linkTypes[blockId] } : {}) }));
  const destination = localize({ ...moved, links: [], linkTypes: undefined,
    crossLinks: [...(moved.crossLinks ?? []), ...outgoing] }, targetId);
  return canvases.map(canvas => {
    let blocks = canvas.blocks.filter(block => canvas.id !== sourceId || block.id !== moved.id)
      .map(block => retarget(block, sourceId, targetId, moved.id));
    if (canvas.id === sourceId) blocks = blocks.map(block => sourceBlock(block, moved.id, targetId));
    if (canvas.id === targetId) blocks = [...blocks, destination].map(block => localize(block, targetId));
    return { ...canvas, blocks };
  });
}

/** Keep source task context and create a linked destination task rather than orphaning its document reference. */
export function movedDocumentTasks(source: CanvasTask[], target: CanvasTask[], movedId: string,
  targetCanvas: CanvasDocument, actor: string): { source: CanvasTask[]; target: CanvasTask[] } {
  const known = new Set(targetCanvas.blocks.map(block => block.id));
  const created = source.filter(task => task.blockIds.includes(movedId)).map(task => {
    const copy = newTask({ title: task.title, detail: task.detail, status: task.status,
      assignee: task.assignee, dueDate: task.dueDate, blockIds: [movedId], reviewer: task.reviewer,
      priority: task.priority, acceptanceCriteria: task.acceptanceCriteria }, actor, known);
    return commentedTask(copy, `Continued from task ${task.id} after its document moved to ${targetCanvas.name}.`, actor);
  });
  if (target.length + created.length > 500) throw new ApiError(409, 'The destination canvas cannot hold the tasks attached to this document.');
  return { source: source.map(task => task.blockIds.includes(movedId)
    ? commentedTask({ ...task, blockIds: task.blockIds.filter(id => id !== movedId) },
      `Document ${movedId} moved to ${targetCanvas.name}; related work continues there.`, actor) : task),
    target: [...target, ...created] };
}
