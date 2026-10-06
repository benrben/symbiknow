import { randomUUID } from 'node:crypto';
import type { ChatViewContext } from '../shared/answer-canvas.js';
import { groupPath, normalizedGroup } from '../shared/groups.js';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import type { CanvasStore } from './storage.js';

export type Candidate = { canvas: CanvasDocument; block: CanvasBlock; localScore: number };

function contextIds(context: ChatViewContext): string[] {
  return [...new Set([ ...context.selectedBlockIds, context.readerBlockId, context.focusBlockId ].filter((id): id is string => Boolean(id)))];
}

function boost(ids: Set<string>, id: string, weight: number): number { return ids.has(id) ? weight : 0; }

function focusedGroup(path: string[], active?: string): number { return active && path.includes(active) ? 0.32 : 0; }

class ContextRanking {
  private readonly anchors: Set<string>;
  private readonly visible: Set<string>;
  private readonly conversationSources: Set<string>;
  private readonly visibleAnswerSources: Set<string>;
  private readonly groups: Set<string>;

  constructor(private readonly canvasId: string, private readonly context: ChatViewContext, private readonly scores: Map<string, number>) {
    this.anchors = new Set(contextIds(context));
    this.visible = new Set(context.visibleBlockIds ?? []);
    this.conversationSources = new Set(context.answerSourceIds ?? []);
    this.visibleAnswerSources = new Set(context.answerFocus?.visibleSourceIds ?? []);
    this.groups = new Set(context.visibleGroups ?? []);
  }

  private groupScores(canvas: CanvasDocument, block: CanvasBlock): { focused: number; visible: number } {
    if (canvas.id !== this.canvasId) return { focused: 0, visible: 0 };
    const path = groupPath(normalizedGroup(block.group) ?? '__ungrouped');
    return { focused: focusedGroup(path, this.context.activeGroup), visible: path.some(group => this.groups.has(group)) ? 0.12 : 0 };
  }

  score(canvas: CanvasDocument, block: CanvasBlock): number {
    const group = this.groupScores(canvas, block);
    return (this.scores.get(block.id) ?? 0) + boost(this.anchors, block.id, 0.35) + boost(this.visible, block.id, 0.2)
      + group.focused + group.visible + boost(this.visibleAnswerSources, block.id, 0.22) + boost(this.conversationSources, block.id, 0.07)
      + (this.context.answerFocus?.focusedSourceId === block.id ? 0.3 : 0);
  }
}

function queryScores(store: CanvasStore, active: CanvasDocument, query: string): Map<string, number> {
  const index = store.similarityIndex(active.workspaceId);
  const queryId = `answer_query_${randomUUID()}`;
  index.upsert(active.id, { id: queryId, title: query, content: query, file: '', kind: 'markdown', x: 0, y: 0, width: 1, height: 1, links: [] });
  try { return new Map(index.neighbors(queryId, 24, { sameCanvas: true, crossCanvas: true }).map(match => [match.blockId, match.score])); }
  finally { index.remove(queryId); }
}

export async function candidatesForQuestion(store: CanvasStore, canvasId: string, query: string, context: ChatViewContext): Promise<Candidate[]> {
  const active = await store.getCanvas(canvasId);
  const workspace = (await store.listWorkspaces()).find(item => item.id === active.workspaceId);
  const canvases = await Promise.all((workspace?.canvases ?? [{ id: canvasId }]).map(item => store.getCanvas(item.id)));
  const ranking = new ContextRanking(canvasId, context, queryScores(store, active, query));
  const blocks = canvases.flatMap(canvas => canvas.blocks.filter(block => !block.archived)
    .map(block => ({ canvas, block, localScore: ranking.score(canvas, block) })));
  return blocks.filter(item => item.localScore > 0).sort((a, b) => b.localScore - a.localScore).slice(0, 20);
}
