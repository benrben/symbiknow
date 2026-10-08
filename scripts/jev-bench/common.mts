// Shared harness: real Project Atlas docs as Jev input documents, real app state helpers, real Jev model.
import { createHash } from 'node:crypto';
import type { JevEvaluationContext, JevInputDocument } from '../../server/jev/actions/context.ts';
import { emptyJevWorkspace } from '../../server/jev/workspace.ts';
import { sectionNames } from '../../shared/document-sections.ts';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideWithJev, onJevUsage, type JevQuestion, type JevAnswer } from '../../server/jev.ts';
export { choice, noul, score } from '../../server/jev.ts';
export type { JevQuestion, JevAnswer };
export { sourceState, evidenceCandidates, candidates, passages } from '../../server/jev/actions/context.ts';
export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '../..');
const settingsPath = join(ROOT, 'data/settings.json');
export function providerKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  let settings: { secrets?: { TYPESAFE_API_KEY?: string } };
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch { throw new Error('Jev benchmarks require TYPESAFE_API_KEY or data/settings.json.'); }
  const key = settings.secrets?.TYPESAFE_API_KEY;
  if (!key) throw new Error('Jev benchmarks require TYPESAFE_API_KEY or secrets.TYPESAFE_API_KEY in data/settings.json.');
  return key;
}
const key = providerKey();
export const usage = { calls: 0, input: 0 };
onJevUsage((u) => { usage.input += u.inputTokens; });

export type Doc = JevInputDocument;
export function makeDoc(id: string, title: string, content: string, canvasId = 'atlas'): Doc {
  const contentHash = createHash('sha256').update(content).digest('hex');
  return { canvasId, block: { id, title, content, file: `${id}.md`, kind: 'markdown',
    x: 0, y: 0, width: 400, height: 300, links: [], tags: [] },
    snapshot: { workspaceId: 'w', canvasId, blockId: id, incarnation: `bench-${id}`,
      sourceGeneration: 1, metadataRevision: 1, contentHash } };
}
export function context(documents: Doc[], canvases: JevEvaluationContext['canvases']): JevEvaluationContext {
  return { workspaceId: 'w', documents, canvases, vocabulary: [], tasks: [],
    settings: { ...emptyJevWorkspace().settings, externalProcessing: true }, apiKey: key,
    decider: (_key, state, questions) => jev(state, questions) };
}
export const atlas: Record<string, Doc> = {};
for (const file of ['README', 'architecture', 'assistant-and-research', 'brand-and-ui', 'canvas-ui', 'chat-internals', 'data-model',
  'document-operations', 'errors', 'history', 'mcp-and-api', 'operations', 'plan-status', 'reflex-internals', 'safe-collaboration',
  'sdk-and-webmcp', 'search-and-brain-tools', 'security-and-access', 'symbi-reflex', 'testing']) {
  const content = readFileSync(join(HERE, 'data/atlas', `${file}.md`), 'utf8');
  atlas[file] = makeDoc(file, content.match(/^#\s+(.+)$/m)?.[1] ?? file, content);
}
export const sections = (document: Doc) => sectionNames(document.block.content);

let active = 0; const waiting: Array<() => void> = [];
export async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}
export function jev(state: unknown, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>> {
  return slot(async () => { usage.calls++; return decideWithJev(key, state, questions, undefined, { maxRetries: 2 }); });
}
export const p = (a: JevAnswer | undefined, option?: string): number => !a ? NaN : a.type === 'noul' ? a.noul
  : a.type === 'choice' ? (option ? a.probabilities[option] ?? 0 : a.probabilities[a.choice]) : NaN;
/** The app's selected(): choice not none/unknown and min(probability, confidence) >= threshold. */
export function selected(a: JevAnswer | undefined, threshold = 0.7): string | undefined {
  if (a?.type !== 'choice' || ['none', 'unknown'].includes(a.choice)) return undefined;
  return Math.min(a.probabilities[a.choice], a.confidence) >= threshold ? a.choice : undefined;
}
export function auroc(pos: number[], neg: number[]): number {
  let w = 0; for (const x of pos) for (const y of neg) w += x > y ? 1 : x === y ? 0.5 : 0; return w / (pos.length * neg.length);
}
export function save(name: string, data: unknown) { mkdirSync(join(HERE, 'out'), { recursive: true }); writeFileSync(join(HERE, 'out', `${name}.json`), JSON.stringify(data, null, 1)); }
export const pct = (n: number, d: number) => `${n}/${d}`;
