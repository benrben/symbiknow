import { randomUUID } from 'node:crypto';
import type { AnswerCanvasResult, AnswerSource, ChatViewContext, ResearchLayout } from '../shared/answer-canvas.js';
import { documentText } from '../shared/document-text.js';
import { excerpt } from '../shared/excerpt.js';
import { groupPath, normalizedGroup } from '../shared/groups.js';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { expectedScore } from './jev-answers.js';
import { decideWithJev, type JevDecider, type JevQuestion } from './jev.js';
import type { CanvasStore } from './storage.js';

type Candidate = { canvas: CanvasDocument; block: CanvasBlock; localScore: number };
const levels = ['Unrelated', 'Context only', 'Partly relevant', 'Useful evidence', 'Directly answers the question'];
const layouts: ResearchLayout[] = ['roadmap', 'kanban', 'architecture', 'mindmap'];
const explicitChat = /\b(?:no canvas|in chat|just answer|answer briefly|quick answer)\b/iu;
const explicitCanvas = /\b(?:draw|build|create|make|show|put|map)\b.{0,48}\b(?:temporary\s+|research\s+)?canvas\b|\b(?:on|as)\s+(?:a\s+|the\s+)?canvas\b|\b(?:mind\s?map|concept graph|diagram|flowchart|kanban|roadmap|architecture|hld|visuali[sz]e|map out)\b/iu;

function surfaceHint(query: string): 'chat' | 'canvas' | 'clarify' | 'unknown' {
  if (explicitChat.test(query)) return 'chat';
  if (explicitCanvas.test(query)) return 'canvas';
  if (/\b(?:compare|trade.?offs?|investigat(?:e|ion)|research|synthesi[sz]e|plan|strategy|design|dependencies|root cause|timeline|blocks?|causes?|how .* connect)\b/iu.test(query)) return 'canvas';
  if (/^\s*(?:help me|explore|look into|work on|what should we do)(?:\s+(?:with|about))?\s+(?:this|here|it)\??\s*$/iu.test(query)) return 'clarify';
  if (/^\s*(?:what|who|when|where|which|is|are|does|do|can)\b[^\n]*\?\s*$/iu.test(query)) return 'chat';
  return 'unknown';
}

function answerSurface(query: string, answer: unknown): 'chat' | 'canvas' | 'clarify' {
  const hint = surfaceHint(query);
  if (explicitChat.test(query)) return 'chat';
  if (explicitCanvas.test(query)) return 'canvas';
  if (answer && typeof answer === 'object' && 'type' in answer && answer.type === 'choice' && 'choice' in answer
    && (answer.choice === 'chat' || answer.choice === 'canvas' || answer.choice === 'clarify')) return answer.choice;
  return hint === 'canvas' || hint === 'clarify' ? hint : 'chat';
}

function inferredLayout(query: string): ResearchLayout {
  if (/roadmap|timeline|milestone|sequence|phases?/iu.test(query)) return 'roadmap';
  if (/kanban|to.?do|tasks?|backlog|work board/iu.test(query)) return 'kanban';
  if (/architecture|system design|high.level design|\bHLD\b|components?|data flow/iu.test(query)) return 'architecture';
  return 'mindmap';
}

async function chooseLayout(query: string, apiKey: string, decider: JevDecider, context: ChatViewContext): Promise<ResearchLayout> {
  const fallback = inferredLayout(query);
  if (!apiKey || context.answerSourceIds?.length || fallback !== 'mindmap') return fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1400);
  try {
    const answers = await decider(apiKey, { request: query }, { research_layout: {
      type: 'choice', instructions: 'Choose the most useful visual structure for the user’s research request in state.request. This is presentation layout, not the answer.',
      criteria: {
        roadmap: 'Ordered phases, chronology, dependencies, milestones',
        kanban: 'Tasks, status, priorities, work to be done',
        architecture: 'Systems, components, interfaces, high-level design',
        mindmap: 'Open-ended exploration, concepts, comparison, general questions',
      },
    } }, undefined, { signal: controller.signal, maxRetries: 0 });
    const answer = answers.research_layout;
    return answer?.type === 'choice' && layouts.includes(answer.choice as ResearchLayout) ? answer.choice as ResearchLayout : fallback;
  } catch { return fallback; }
  finally { clearTimeout(timer); }
}

function sourceExcerpt(content: string, query: string): string {
  const text = documentText(content).replace(/\s+/gu, ' ').trim();
  const terms = query.toLocaleLowerCase().match(/\p{L}[\p{L}\p{N}]{2,}/gu) ?? [];
  const lower = text.toLocaleLowerCase();
  const match = terms.map(term => lower.indexOf(term)).find(index => index >= 0) ?? -1;
  const start = match < 0 ? 0 : Math.max(0, match - 90);
  return `${start ? '…' : ''}${text.slice(start, start + 300)}${start + 300 < text.length ? '…' : ''}`;
}

function contextIds(context: ChatViewContext): string[] {
  return [...new Set([
    ...context.selectedBlockIds, context.readerBlockId, context.focusBlockId,
  ].filter((id): id is string => Boolean(id)))];
}

async function candidatesForQuestion(store: CanvasStore, canvasId: string, query: string,
  context: ChatViewContext): Promise<Candidate[]> {
  const active = await store.getCanvas(canvasId);
  const workspace = (await store.listWorkspaces()).find(item => item.id === active.workspaceId);
  const canvases = await Promise.all((workspace?.canvases ?? [{ id: canvasId }]).map(item => store.getCanvas(item.id)));
  const index = store.similarityIndex(active.workspaceId);
  const queryId = `answer_query_${randomUUID()}`;
  index.upsert(canvasId, { id: queryId, title: query, content: query, file: '', kind: 'markdown',
    x: 0, y: 0, width: 1, height: 1, links: [] });
  let matches: Array<{ blockId: string; score: number }>;
  try {
    matches = index.neighbors(queryId, 24, { sameCanvas: true, crossCanvas: true });
  } finally { index.remove(queryId); }
  const scores = new Map(matches.map(match => [match.blockId, match.score]));
  const anchors = new Set(contextIds(context));
  const visible = new Set(context.visibleBlockIds ?? []);
  const conversationSources = new Set(context.answerSourceIds ?? []);
  const visibleAnswerSources = new Set(context.answerFocus?.visibleSourceIds ?? []);
  const groups = new Set(context.visibleGroups ?? []);
  const blocks = canvases.flatMap(canvas => canvas.blocks.filter(block => !block.archived)
    .map(block => {
      const path = groupPath(normalizedGroup(block.group) ?? '__ungrouped');
      const inFocusedGroup = canvas.id === canvasId && context.activeGroup && path.includes(context.activeGroup);
      const inVisibleGroup = canvas.id === canvasId && path.some(group => groups.has(group));
      return { canvas, block, localScore: (scores.get(block.id) ?? 0) + (anchors.has(block.id) ? 0.35 : 0)
        + (visible.has(block.id) ? 0.2 : 0) + (inFocusedGroup ? 0.32 : 0) + (inVisibleGroup ? 0.12 : 0)
        + (visibleAnswerSources.has(block.id) ? 0.22 : 0) + (conversationSources.has(block.id) ? 0.07 : 0)
        + (context.answerFocus?.focusedSourceId === block.id ? 0.3 : 0) };
    }));
  return blocks.filter(item => item.localScore > 0).sort((a, b) => b.localScore - a.localScore).slice(0, 20);
}

async function jevScores(candidates: Candidate[], query: string, apiKey: string,
  decider: JevDecider): Promise<{ scores: number[]; surface: 'chat' | 'canvas' | 'clarify' } | null> {
  if (!apiKey) return null;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const questions: Record<string, JevQuestion> = Object.fromEntries(candidates.map((_, index) => [`source_${index}`, {
    type: 'score', instructions: `How useful is state.sources[${index}] for answering state.question? Judge its content, not just its title.`, criteria: levels,
  }]));
  questions.answer_surface = { type: 'choice',
    instructions: 'Choose where the agent should answer state.question. Use canvas only when a persistent visual structure with several distinct, linked findings, components, phases, or evidence groups materially helps. A source citation alone is not a reason. Short facts, definitions, status checks, and simple follow-ups belong in chat. Respect an explicit request to draw or to answer in chat.',
    criteria: { chat: 'A concise direct answer is clearest in the chat conversation',
      canvas: 'A connected visual research artifact is necessary or clearly better',
      clarify: 'The request is too ambiguous to choose between working on the current view, building a temporary research canvas, or navigating to relevant content' } };
  try {
    const request = decider(apiKey, { question: query, sources: candidates.map(item => ({
      title: item.block.title, canvas: item.canvas.name,
      content: excerpt(documentText(item.block.content), { budget: 1500, focus: 'claims' }),
    })) }, questions, undefined, { signal: controller.signal, maxRetries: 0 });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Jev source selection timed out'));
    }, 3500); });
    const answers = await Promise.race([request, timeout]);
    return { scores: candidates.map((_, index) => expectedScore(answers[`source_${index}`], levels.length)),
      surface: answerSurface(query, answers.answer_surface) };
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}

export async function selectAnswerCanvas(store: CanvasStore, canvasId: string, query: string,
  context: ChatViewContext, decider: JevDecider = decideWithJev): Promise<AnswerCanvasResult> {
  const candidates = await candidatesForQuestion(store, canvasId, query, context);
  const apiKey = await store.getJevApiKey();
  const decision = await jevScores(candidates, query, apiKey, decider);
  const surface = decision?.surface ?? answerSurface(query, null);
  const layout = surface === 'canvas' ? await chooseLayout(query, apiKey, decider, context) : undefined;
  const ranked = candidates.map((candidate, index) => ({ candidate,
    score: decision?.scores[index] ?? Math.min(1, candidate.localScore) }))
    .filter(item => item.score >= (decision ? 0.38 : 0.08))
    .sort((a, b) => b.score - a.score || b.candidate.localScore - a.candidate.localScore)
    .slice(0, 7);
  const sources: AnswerSource[] = ranked.map(({ candidate, score }) => ({
    canvasId: candidate.canvas.id, canvasName: candidate.canvas.name,
    blockId: candidate.block.id, title: candidate.block.title,
    excerpt: sourceExcerpt(candidate.block.content, query), relevance: score,
    contentHash: candidate.block.contentHash,
  }));
  return { query, canvasId, selection: decision ? 'jev' : 'local', sources, layout, surface };
}
