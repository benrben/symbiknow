import { afterEach, describe, expect, it, vi } from 'vitest';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { chatMcpSources } from './chat-mcp-sources.js';
import type { PreparedRequest } from './chat-stream-types.js';

type ToolCall = { name: string; args: Record<string, unknown> };
type Responses = Partial<Record<'ask_symbi' | 'search_docs', (args: Record<string, unknown>) => unknown>>;

const canvases: Record<string, { id: string; name: string; blocks: [] }> = {
  roadmap: { id: 'roadmap', name: 'Product roadmap', blocks: [] },
  research: { id: 'research', name: 'Research', blocks: [] },
};
const documents: Record<string, { id: string; title: string; content: string; contentHash: string }> = {
  'roadmap:brief': { id: 'brief', title: 'Empty brief', content: '', contentHash: 'hash-brief' },
  'roadmap:launch': { id: 'launch', title: 'Launch checklist', content: 'Ship the beta in May after the security review.', contentHash: 'hash-launch' },
  'research:interviews': { id: 'interviews', title: 'Interviews', content: 'Customers asked for offline mode first.', contentHash: 'hash-interviews' },
  'research:survey': { id: 'survey', title: 'Survey', content: 'Most teams plan quarterly.', contentHash: 'hash-survey' },
};

/** Canonical MCP tools as the chat agent receives them, answering from a small fixed workspace. */
function canonicalTools(responses: Responses) {
  const calls: ToolCall[] = [];
  const canonical = (name: string, answer: (args: Record<string, unknown>) => unknown) => tool(async args => {
    calls.push({ name, args });
    return JSON.stringify(answer(args));
  }, { name, description: `Canonical ${name}`, schema: z.looseObject({}) });
  const tools: StructuredToolInterface[] = [
    canonical('read_canvas', args => canvases[String(args.canvasId)]),
    canonical('read_doc', args => documents[`${String(args.canvasId)}:${String(args.blockId)}`]),
    ...Object.entries(responses).map(([name, answer]) => canonical(name, answer)),
  ];
  return { tools, calls };
}

function preparedRequest(latest: string, view: Partial<PreparedRequest['currentView']> = {}): PreparedRequest {
  return { canvasId: 'roadmap', conversationId: 'conversation-1', activeCanvas: { ...canvases.roadmap, blocks: [] } as unknown as PreparedRequest['activeCanvas'],
    currentView: { selectedBlockIds: [], ...view }, history: [], requestedResearchCanvas: false,
    context: { latest, previousAssistant: '', previousUser: '' } };
}

const passage = (excerpt: string, score: number) => ({ excerpt, score, start: 0, end: excerpt.length });
const match = (canvasId: string, blockId: string | undefined, extra: Record<string, unknown> = {}) =>
  ({ canvasId, ...(blockId ? { blockId } : {}), title: blockId ?? 'Canvas', reason: 'semantic', href: `/?canvas=${canvasId}`, passages: [], ...extra });

afterEach(() => { vi.restoreAllMocks(); });

describe('chat MCP source retrieval', () => {
  it('combines view anchors with ranked matches and reads each canvas once', async () => {
    const { tools, calls } = canonicalTools({ ask_symbi: () => ({ matches: [
      match('research', undefined),
      match('research', 'interviews', { confidence: 0.92, passages: [passage('offline mode first', 0.4)] }),
      match('research', 'survey', { passages: [passage('plan quarterly', 0.61)] }),
      match('roadmap', 'launch'),
    ] }) });
    const result = await chatMcpSources(tools, preparedRequest('Compare the launch roadmap with customer interviews?',
      { selectedBlockIds: ['brief'], readerBlockId: 'brief' }));
    expect(result).toMatchObject({ query: 'Compare the launch roadmap with customer interviews?', canvasId: 'roadmap', surface: 'canvas', layout: 'roadmap' });
    expect(result!.sources.map(item => [item.blockId, item.canvasName, item.excerpt, item.relevance, Boolean(item.evidence)])).toEqual([
      ['brief', 'Product roadmap', '', 1, false],
      ['interviews', 'Research', 'offline mode first', 0.92, true],
      ['survey', 'Research', 'plan quarterly', 0.61, true],
      ['launch', 'Product roadmap', 'Ship the beta in May after the security review.', 1, true],
    ]);
    expect(calls.filter(call => call.name === 'read_canvas').map(call => call.args.canvasId)).toEqual(['roadmap', 'research']);
  });

  it('falls back to source-text search when semantic search has no matches', async () => {
    const { tools, calls } = canonicalTools({
      ask_symbi: () => ({ matches: [] }),
      search_docs: () => ({ items: [{ canvasId: 'research', blockId: 'survey', title: 'Survey', excerpt: 'Most teams plan quarterly.' }] }),
    });
    const result = await chatMcpSources(tools, preparedRequest('What do teams say about planning?'));
    expect(result).toMatchObject({ surface: 'chat', sources: [{ canvasId: 'research', blockId: 'survey', excerpt: 'Most teams plan quarterly.' }] });
    expect(result).not.toHaveProperty('layout');
    expect(calls.map(call => call.name)).toEqual(['ask_symbi', 'search_docs', 'read_canvas', 'read_doc']);
  });

  it('searches individual terms while the semantic index rebuilds and the full question finds nothing', async () => {
    const { tools, calls } = canonicalTools({
      ask_symbi: () => { throw new Error('The local search index is unavailable while it rebuilds.'); },
      search_docs: args => ({ items: args.query === 'offline' ? [{ canvasId: 'research', blockId: 'interviews', title: 'Interviews' }] : [] }),
    });
    const request = { ...preparedRequest('Draft the offline rollout'), requestedResearchCanvas: true };
    const result = await chatMcpSources(tools, request);
    expect(result!.sources).toEqual([expect.objectContaining({ blockId: 'interviews', excerpt: 'Customers asked for offline mode first.' })]);
    expect(calls.filter(call => call.name === 'search_docs').map(call => call.args)).toEqual([
      { query: 'Draft the offline rollout', limit: 7 }, { query: 'draft', limit: 3 }, { query: 'offline', limit: 3 }, { query: 'rollout', limit: 3 }]);
  });

  it('skips retrieval for a navigation request', async () => {
    const { tools, calls } = canonicalTools({ ask_symbi: () => ({ matches: [] }) });
    await expect(chatMcpSources(tools, preparedRequest('Open the launch checklist'))).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it.each([
    ['a semantic search failure', { ask_symbi: () => { throw new Error('Embedding provider timed out'); } }],
    ['a catalog without semantic search', { search_docs: () => ({ items: [] }) }],
  ])('continues without prepared sources after %s', async (_case, responses: Responses) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tools, calls } = canonicalTools(responses);
    await expect(chatMcpSources(tools, preparedRequest('What changed in the launch plan?'))).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('Local chat source retrieval unavailable; continuing with document tools.', 'Error');
    expect(calls.filter(call => call.name === 'search_docs')).toEqual([]);
  });
});
