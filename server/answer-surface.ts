import type { ResearchLayout } from '../shared/answer-canvas.js';

export type AnswerSurface = 'chat' | 'canvas';
const explicitChat = /\b(?:no canvas|in chat|just answer|answer briefly|quick answer)\b/iu;
const explicitCanvas = /\b(?:draw|build|create|make|show|put|map)\b.{0,48}\b(?:temporary\s+|research\s+)?canvas\b|\b(?:on|as)\s+(?:a\s+|the\s+)?canvas\b|\b(?:mind\s?map|concept graph|diagram|flowchart|kanban|roadmap|architecture|hld|visuali[sz]e|map out)\b/iu;

/** Local presentation hints; no provider or structured decision is consulted. */
export function answerSurface(query: string): AnswerSurface {
  if (explicitChat.test(query)) return 'chat';
  if (explicitCanvas.test(query)) return 'canvas';
  return /\b(?:compare|trade.?offs?|investigat(?:e|ion)|research|synthesi[sz]e|plan|strategy|design|dependencies|root cause|timeline|blocks?|causes?|how .* connect)\b/iu.test(query) ? 'canvas' : 'chat';
}

export function chooseLayout(query: string): ResearchLayout {
  if (/roadmap|timeline|milestone|sequence|phases?/iu.test(query)) return 'roadmap';
  if (/kanban|to.?do|tasks?|backlog|work board/iu.test(query)) return 'kanban';
  if (/architecture|system design|high.level design|\bHLD\b|components?|data flow/iu.test(query)) return 'architecture';
  return 'mindmap';
}
