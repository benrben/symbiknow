import type { AnswerSource, ResearchCanvasBlock, ResearchCanvasPatch } from './answer-canvas.js';

const sourceId = (source: AnswerSource) => `${source.canvasId}:${source.blockId}`;

/** Turn explicit Markdown sections into research blocks without inventing relationships. */
export function patchFromMarkdown(query: string, answer: string, sources: AnswerSource[]): ResearchCanvasPatch {
  const sourceIds = sources.map(sourceId);
  const sections: Array<{ title: string; content: string; type: ResearchCanvasBlock['type'] }> = [];
  const lines = answer.trim().split(/\r?\n/u);
  let title = 'Key finding';
  let content: string[] = [];
  const flush = () => {
    const text = content.join('\n').trim();
    if (text) sections.push({ title, content: text, type: /```mermaid\b/iu.test(text) ? 'diagram' : 'text' });
    content = [];
  };
  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/u);
    if (heading) { flush(); title = heading[1].trim(); }
    else content.push(line);
  }
  flush();
  if (!sections.length) sections.push({ title: 'Key finding', content: answer.trim() || 'Research in progress.', type: 'text' });
  const blocks: ResearchCanvasBlock[] = sections.slice(0, 12).map((section, index) => ({
    id: `section-${index + 1}`, type: section.type, title: section.title, content: section.content,
    sourceIds: index === 0 || sections.length === 1 ? sourceIds : [],
  }));
  return { query, blocks, edges: [] };
}
