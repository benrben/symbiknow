import type { AnswerSource, ResearchCanvasBlock, ResearchCanvasEdge } from '../shared/answer-canvas';
import type { ResearchBlock, ResearchEdge } from './research-canvas-types';
import { sourceKey } from './research-canvas-content';

function sharesEvidence(block: ResearchBlock, local: ResearchCanvasBlock) {
  return local.sourceIds.some(id => block.sources.some(source => sourceKey(source) === id));
}

export function appendSharedEvidence(blocks: ResearchBlock[], local: ResearchCanvasBlock[], edges: ResearchEdge[], globalId: (id: string) => string) {
  const prior = [...blocks].reverse().find(block => local.some(item => sharesEvidence(block, item)));
  if (!prior) return;
  // The same predicate selected prior, so a matching local document always exists.
  const related = local.find(item => sharesEvidence(prior, item))!;
  edges.push({ source: prior.id, target: globalId(related.id), label: 'shared evidence' });
}

function knownEndpoints(local: ResearchCanvasBlock[], edge: ResearchCanvasEdge) {
  return local.some(block => block.id === edge.from) && local.some(block => block.id === edge.to);
}

export function appendPatchEdges(local: ResearchCanvasBlock[], authored: ResearchCanvasEdge[], edges: ResearchEdge[], globalId: (id: string) => string) {
  for (const edge of authored) {
    if (knownEndpoints(local, edge)) edges.push({ source: globalId(edge.from), target: globalId(edge.to), label: edge.label || 'connects' });
  }
}

export function citedSources(block: ResearchCanvasBlock, sources: AnswerSource[]) {
  return sources.filter(source => block.sourceIds.includes(sourceKey(source)));
}
