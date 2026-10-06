import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { jevActions, type JevPrincipal } from '../../shared/jev-types.js';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { evaluateJevAction } from './actions.js';

type ProviderDocument = { id: string; title: string; passages: Array<{ id: string; text: string }> };
type ProviderState = { document?: ProviderDocument; source?: ProviderDocument; kind?: string; labelCandidates?: Array<{ name: string }>; logicalTopicCandidates?: Array<{ name: string }>; questionSets?: ProviderState[] };
const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let runtime: JevRuntime;
let store: CanvasStore; let workspaceId: string; let canvasId: string; let documents: CanvasBlock[];

function html(category: string, heading: string, fact: string): string {
  return `---\nformat: html\ntitle: PRIVATE_METADATA\n---\n<!doctype html><html><head><title>PRIVATE_CHROME</title><style>${'PRIVATE_CSS{color:red}\n'.repeat(50)}</style><script>PRIVATE_SCRIPT()</script></head><body><span>${category} · ${heading}</span><h1>${heading}</h1><p>${fact}</p><p>Saved documents retain checked source evidence.</p><pre>PRIVATE_IMPLEMENTATION</pre></body></html>`;
}
function groupChoice(question: Extract<JevQuestion, { type: 'choice' }>, state: ProviderState): string {
  const local = state.document ?? state.source;
  const name = local?.passages.some(passage => passage.text.startsWith('Platform ·')) ? 'Platform' : 'Configuration';
  return Object.keys(question.criteria).find(key => question.criteria[key].startsWith(`${name} (`)) ?? 'none';
}
function support(id: string, state: ProviderState): number {
  if (id.startsWith('label_')) return labelSupport(id, state);
  if (id.startsWith('logicalTopic_')) return state.logicalTopicCandidates?.[Number(id.slice(13))]?.name === state.document?.title ? .99 : .01;
  return ['fit', 'coherent'].includes(id) || /^(purpose|containment)_\d+$/.test(id) ? 0.99 : 0.01;
}
function labelSupport(id: string, state: ProviderState): number {
  const label = state.labelCandidates?.[Number(id.slice(6))];
  return label?.name === state.document?.title ? 0.99 : 0.01;
}
function fixedChoice(id: string, state: ProviderState): string | undefined {
  const choices: Record<string, string | undefined> = { role: state.document?.title === 'Configuration' ? 'instructions' : 'specification',
    pair: 'none', canvas: 'c0', concept: state.kind === 'entity' ? 'none' : undefined };
  return choices[id];
}
function choice(id: string, question: Extract<JevQuestion, { type: 'choice' }>, state: ProviderState): string {
  if (id === 'group') return groupChoice(question, state);
  const fixed = fixedChoice(id, state);
  if (fixed && fixed in question.criteria) return fixed;
  const keys = Object.keys(question.criteria);
  return 'p2' in question.criteria ? 'p2' : keys[0];
}
function answer(id: string, question: JevQuestion, state: ProviderState): JevAnswer {
  const batch = /^(\d+)__(.+)$/.exec(id);
  const scoped = batch ? state.questionSets![Number(batch[1])] : state;
  const name = batch?.[2] ?? id;
  if (question.type === 'noul') return { type: 'noul', noul: support(name, scoped) };
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const selected = question.type === 'choice' ? choice(name, question, scoped) : '0';
  const probabilities = Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0]));
  return question.type === 'choice' ? { type: 'choice', choice: selected, confidence: 0.99, probabilities }
    : { type: 'score', score: 0, confidence: 0.99, probabilities };
}
// Ordinary saved-source setup is outside the decision timing; processing starts only in the test.
beforeAll(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  root = await mkdtemp(path.join(tmpdir(), 'jev-html-native-'));
  store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'HTML platform knowledge' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Technical sources' })).id;
  documents = await Promise.all([
    store.createBlock(canvasId, { title: 'Architecture', content: html('Platform', 'Architecture', 'The <code>CanvasStore</code> persists documents behind the authenticated server API.') }),
    store.createBlock(canvasId, { title: 'Server & REST API', content: html('Platform', 'Server &amp; REST API', 'The server authenticates requests and saves checked documents through <code>/api</code>.') }),
    store.createBlock(canvasId, { title: 'Configuration', content: html('Operations', 'Configuration', 'Configure hosting credentials and deployment ports before starting the server.') }),
  ]);
});
afterAll(async () => { await runtime?.shutdown(); if (root) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it('automatically classifies, groups and labels HTML sources from visible body evidence while preserving their original bytes', async () => {
  const profiled = new Set<string>();
  const labelGroups: Array<{ id: string; group: string | undefined }> = [];
  const filingLabels: Array<{ id: string; title: string; tags: string[] }> = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer html-native-provider');
    const body = JSON.parse(String(options?.body)) as { state: ProviderState; questions: Record<string, JevQuestion> };
    expect(JSON.stringify(body.state)).not.toContain('PRIVATE_');
    if (body.questions.role) {
      const local = body.state.document!; profiled.add(local.id);
      expect(local.passages.some(passage => /persists documents|authenticates requests|Configure hosting/.test(passage.text))).toBe(true);
      expect(local.passages.every(passage => !/[<>]/.test(passage.text))).toBe(true);
    }
    return Response.json({ model: 'native-html-provider', answers: Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => [id, answer(id, question, body.state)])) });
  });
  runtime = new JevRuntime(store, { apiKey: 'html-native-provider', fetcher, startTimer: false,
    evaluate: async (context, request) => {
      if (request.action === 'label') {
        const source = context.documents.find(document => request.blockIds?.includes(document.block.id))!;
        labelGroups.push({ id: source.block.id, group: source.block.group });
      }
      if (request.action === 'file') {
        const source = context.documents.find(document => request.blockIds?.includes(document.block.id))!;
        filingLabels.push({ id: source.block.id, title: source.block.title, tags: source.block.tags ?? [] });
      }
      return evaluateJevAction(context, request);
    } });
  await runtime.idle();
  const state = await runtime.read(workspaceId, owner);
  const reloaded = await new CanvasStore(root).getCanvas(canvasId, true);
  expect(profiled).toEqual(new Set(documents.map(document => document.id)));
  expect(labelGroups).toHaveLength(3);
  expect(labelGroups.every(source => source.group === undefined)).toBe(true);
  expect(filingLabels).toHaveLength(3);
  expect(filingLabels.every(source => source.tags.includes(source.title))).toBe(true);
  expect(state.jobs.every(job => job.state === 'completed'), JSON.stringify(state.jobs.filter(job => job.error).map(job => job.error))).toBe(true);
  for (const document of documents) {
    expect(new Set(state.jobs.filter(job => job.request.blockIds?.includes(document.id)).map(job => job.request.action))).toEqual(new Set(jevActions));
    expect(state.profiles[`${canvasId}:${document.id}`]).toMatchObject({ role: document.title === 'Configuration' ? 'instructions' : 'specification' });
    const saved = reloaded.blocks.find(block => block.id === document.id)!;
    expect(saved.content).toBe(document.content);
    expect(saved.tags).toContain(document.title);
    if (document.title === 'Configuration') expect(saved.group).not.toBe('custom:platform');
    else expect(saved.group).toBe('custom:platform');
  }
  const platform = state.vocabulary.filter(term => term.kind === 'group' && term.name === 'Platform');
  expect(platform).toHaveLength(1);
  expect(platform[0].members.map(member => member.blockId)).toContain(documents[0].id);
  expect(state.proposals.filter(proposal => proposal.state === 'pending')).toEqual([]);
  for (const proposal of state.proposals) for (const evidence of proposal.evidence) {
    const source = documents.find(document => document.id === evidence.source.blockId)!;
    expect(source.content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
    expect(evidence.quote).not.toContain('PRIVATE_');
  }
});
