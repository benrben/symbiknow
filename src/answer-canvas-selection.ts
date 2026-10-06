import type { AnswerCanvasGraph } from './useAnswerCanvasGraph';

export function answerCanvasSelection(graph: AnswerCanvasGraph['graph'], search: string, duplicateId: string) {
  const matches = search.trim() ? graph.blocks.filter(block => (block.title + ' ' + block.content).toLocaleLowerCase()
    .includes(search.trim().toLocaleLowerCase())) : [];
  const candidate = graph.blocks.find(block => block.id === duplicateId);
  const titleWords = candidate?.title.toLocaleLowerCase().split(/\W+/u).filter(word => word.length > 3) ?? [];
  const similar = candidate ? graph.blocks.filter(block => block.id !== candidate.id && (
    block.content.trim() === candidate.content.trim() || titleWords.filter(word => block.title.toLocaleLowerCase().includes(word)).length >= 2)) : [];
  return { matches, candidate, similar };
}
