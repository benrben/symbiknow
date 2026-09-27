import { documentText } from '../shared/document-text.js';
import { excerpt } from '../shared/excerpt.js';
import type { CanvasDocument } from '../shared/types.js';
import { effectiveJevPolicy, type JevPolicy } from '../shared/policy.js';
import { ApiError } from './errors.js';
import { estimateJevTokens, JEV_STATE_TOKEN_LIMIT, type JevAnswer, type JevDecider, type JevQuestion } from './jev.js';

export interface FindCanvasHomesInput {
  canvas: CanvasDocument;
  canvases: CanvasDocument[];
  apiKey: string;
  decider: JevDecider;
  policy?: Partial<JevPolicy>;
}

export interface CanvasHomeFinding {
  kind: 'move' | 'split';
  fromCanvasId: string;
  toCanvasId: string;
  blockIds: string[];
  confidence: number;
  evidence: { questionId: string; answer: string; excerpt: string }[];
}

interface SelectedHome {
  blockId: string;
  toCanvasId: string;
  confidence: number;
  evidence: CanvasHomeFinding['evidence'][number];
}

const concurrency = 6;
const maxTitlesPerCanvas = 10;
const homeInstructions = 'Which canvas best fits `state.document`? Answer stay to keep it on its current canvas.';

async function mapLimited<T, U>(values: T[], limit: number, work: (value: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await work(values[index]);
    }
  }));
  return results;
}

/** Named choices for every OTHER canvas the document could move to. "stay" is the only way to keep it here; the current canvas is never offered as a numbered choice. */
function canvasChoices(destinations: CanvasDocument[], titleCap: number): Record<string, string> {
  const choices: Record<string, string> = {};
  destinations.forEach((canvas, index) => {
    const titles = canvas.blocks.filter(block => !block.archived).slice(0, titleCap).map(block => block.title);
    choices[`c${index}`] = `${canvas.name}${titles.length ? ` — Documents: ${titles.join('; ')}` : ' — Empty canvas'}`;
  });
  choices.stay = 'Keep this document on its current canvas';
  return choices;
}

/** Shrinks each canvas's title list, and drops it if still too big, so this document's question and state fit the token budget. */
function fitChoices(destinations: CanvasDocument[], state: unknown): Record<string, string> {
  for (let titleCap = maxTitlesPerCanvas; titleCap >= 0; titleCap--) {
    const choices = canvasChoices(destinations, titleCap);
    const question: JevQuestion = { type: 'choice', instructions: homeInstructions, criteria: choices };
    if (estimateJevTokens(state) + estimateJevTokens(question) <= JEV_STATE_TOKEN_LIMIT) return choices;
  }
  return canvasChoices(destinations, 0);
}

function answerFor(answers: Record<string, JevAnswer>, id: string, choices: Record<string, string>): { value: string; confidence: number } {
  const answer = answers[id];
  if (answer?.type !== 'choice' || !Object.hasOwn(choices, answer.choice) || !Number.isFinite(answer.confidence)) {
    throw new ApiError(502, `Jev returned no valid canvas choice for ${id}`);
  }
  return { value: answer.choice, confidence: answer.confidence };
}

/** Read-only suggestions to move individual documents or split a canvas. One Jev request per document, bounded concurrency. */
export async function findCanvasHomes(input: FindCanvasHomesInput): Promise<CanvasHomeFinding[]> {
  const policy = effectiveJevPolicy(input.policy);
  const destinations = input.canvases
    .filter(canvas => canvas.id !== input.canvas.id && canvas.workspaceId === input.canvas.workspaceId)
    .slice(0, 254);
  if (!destinations.length) return [];
  const blocks = input.canvas.blocks.filter(block => !block.archived);

  const results = await mapLimited(blocks, concurrency, async (block): Promise<SelectedHome | undefined> => {
    const index = blocks.indexOf(block);
    const state = { currentCanvas: input.canvas.name,
      document: { title: block.title, purpose: block.purpose, content: excerpt(documentText(block.content), { budget: 1200 }) } };
    const choices = fitChoices(destinations, state);
    const questionId = `d${index}_home`;
    const questions: Record<string, JevQuestion> = { [questionId]: { type: 'choice', instructions: homeInstructions, criteria: choices } };
    const answers = await input.decider(input.apiKey, state, questions);
    const answer = answerFor(answers, questionId, choices);
    if (answer.confidence < policy.move.show || answer.value === 'stay') return undefined;
    const target = destinations[Number(answer.value.slice(1))];
    if (!target) return undefined;
    return { blockId: block.id, toCanvasId: target.id, confidence: answer.confidence,
      evidence: { questionId, answer: target.name, excerpt: state.document.content.head.slice(0, 240) } };
  });
  const selected = results.filter((home): home is SelectedHome => home !== undefined);

  const byDestination = new Map<string, SelectedHome[]>();
  for (const home of selected) byDestination.set(home.toCanvasId, [...(byDestination.get(home.toCanvasId) ?? []), home]);
  const findings: CanvasHomeFinding[] = [];
  for (const [toCanvasId, homes] of byDestination) {
    if (homes.length > 1 && homes.length / blocks.length > 0.4) {
      findings.push({ kind: 'split', fromCanvasId: input.canvas.id, toCanvasId,
        blockIds: homes.map(home => home.blockId), confidence: Math.min(...homes.map(home => home.confidence)),
        evidence: homes.map(home => home.evidence) });
    } else {
      findings.push(...homes.map(home => ({ kind: 'move' as const, fromCanvasId: input.canvas.id, toCanvasId,
        blockIds: [home.blockId], confidence: home.confidence, evidence: [home.evidence] })));
    }
  }
  return findings.sort((a, b) => b.confidence - a.confidence || a.toCanvasId.localeCompare(b.toCanvasId));
}
