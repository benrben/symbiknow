import { useMemo } from 'react';
import { editedResearchGraph, researchCanvasDocument } from './research-edits';
import type { ResearchCanvasEdits } from './research-edits';
import type { AnswerCanvasTurn } from '../shared/answer-canvas';
import type { AnswerCanvasProps } from './answer-canvas-types';
import { sourceKey } from './answer-canvas-helpers';

export function useAnswerCanvasGraph({ turns, layout, edits }: AnswerCanvasProps) {
  const graph = useMemo(() => editedResearchGraph(turns, layout, edits), [turns, layout, edits]);
  const canvas = useMemo(() => researchCanvasDocument(turns, layout, edits), [turns, layout, edits]);
  const sources = useMemo(() => [...new Map(turns.flatMap(turn => turn.sources).map(source => [sourceKey(source), source])).values()], [turns]);
  const sourceLabels = useMemo(() => Object.fromEntries(sources.map(source => [sourceKey(source), source.title])), [sources]);
  const latest = turns.at(-1);
  const { first, story } = latestAnswerStory(graph, edits, latest);
  return { graph, canvas, sources, sourceLabels, latest, first, story };
}
function latestAnswerStory(graph: ReturnType<typeof editedResearchGraph>, edits: ResearchCanvasEdits, latest: AnswerCanvasTurn | undefined) {
  const manuallyAdded = new Set(edits.added.map(block => block.id));
  const latestBlocks = graph.blocks.filter(block => block.turnId === latest?.id && !manuallyAdded.has(block.id));
  const first = latestBlocks.find(block => !graph.edges.some(edge => edge.target === block.id && latestBlocks.some(item => item.id === edge.source)))
    ?? latestBlocks[0];
  const story = first ? [first, ...latestBlocks.filter(block => block.id !== first.id)] : [];
  return { first, story };
}
export type AnswerCanvasGraph = ReturnType<typeof useAnswerCanvasGraph>;
