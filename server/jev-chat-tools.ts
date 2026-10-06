import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { jevActions, type JevPrincipal } from '../shared/jev-types.js';
import type { CanvasStore } from './storage.js';
import { projectJevState } from './jev-read-projections.js';
import { SymbiIndexLifecycle } from './symbi-index-lifecycle.js';

const principal = (canvasId: string): JevPrincipal => ({ id: 'symbi', kind: 'automation', access: 'propose',
  allowedCanvasIds: [canvasId], canApprove: false, canConfigure: false });

export function jevChatTools(store: CanvasStore, canvasId: string): StructuredToolInterface[] {
  const scope = principal(canvasId);
  const workspace = async () => (await store.getCanvasSummary(canvasId)).workspaceId;
  const runtime = async () => (await import('./jev/runtime.js')).getJevRuntime(store);
  const sourceSearch = async (query: string) => {
    const lifecycle = SymbiIndexLifecycle.forStore(store);
    if (lifecycle) {
      const expectedDocumentIds = await lifecycle.expectedDocumentIds([canvasId], canvasId);
      const result = await lifecycle.search({ query, mode: 'hybrid', canvasId,
        allowedCanvasIds: [canvasId], allowedDocumentIds: expectedDocumentIds, expectedDocumentIds, limit: 40 });
      const found: Record<string, { title: string; excerpt: string; contentHash: string }> = {};
      for (const passage of result.passages) {
        const block = await store.getCanvasBlock(canvasId, passage.blockId);
        if (block.contentHash !== passage.contentHash || block.content.slice(passage.startOffset, passage.endOffset) !== passage.excerpt) continue;
        found[`${canvasId}:${block.id}`] = { title: block.title, excerpt: passage.excerpt, contentHash: passage.contentHash };
      }
      return found;
    }
    return Object.fromEntries((await store.search(query)).filter(hit => hit.canvasId === canvasId)
      .map(hit => [`${canvasId}:${hit.blockId}`, { title: hit.title, excerpt: hit.excerpt,
        contentHash: '' }]));
  };
  const related = async (blockId: string) => {
    const source = await store.getCanvasBlock(canvasId, blockId);
    const canvas = await store.getCanvasSummary(canvasId);
    const semantic = await sourceSearch([source.title, source.purpose, ...(source.tags ?? [])].filter(Boolean).join(' '));
    return canvas.blocks.filter(block => block.id !== blockId).map(block => {
      const reasons = [];
      if (source.links.includes(block.id) || block.links.includes(source.id)) reasons.push('linked');
      if (source.group && source.group === block.group) reasons.push('same group');
      if (source.tags?.some(tag => block.tags?.includes(tag))) reasons.push('same topic');
      if (semantic[`${canvasId}:${block.id}`]) reasons.push('source similarity');
      return { canvasId, blockId: block.id, title: block.title, reasons };
    }).filter(item => item.reasons.length);
  };
  const reads = ['jev_profile', 'find_by', 'related', 'memory_map', 'jev_activity', 'brain_inbox'].map(name => tool(async ({ blockId, query }) => {
    if (name === 'find_by') return JSON.stringify(query?.trim() ? await sourceSearch(query) : {});
    if (name === 'related') return JSON.stringify(blockId ? await related(blockId) : []);
    const state = await (await runtime()).read(await workspace(), scope);
    if (name === 'jev_profile') {
      const projected = projectJevState(name, state, blockId, blockId ? '' : query) as {
        profiles: Record<string, unknown>; coverage: unknown };
      return JSON.stringify({ ...projected.profiles, _coverage: projected.coverage });
    }
    return JSON.stringify(projectJevState(name, state, blockId, query));
  }, { name, description: `Read scoped ${name.replaceAll('_', ' ')} without starting analysis or changing saved organization.`,
    schema: z.object({ blockId: z.string().optional(), query: z.string().optional() }) }));
  return [...reads, tool(async input => JSON.stringify(await (await runtime()).run(await workspace(), { ...input, canvasId }, scope)), {
    name: 'jev_do', description: 'Request a bounded typed organization action. Changes remain review proposals; you cannot approve them.',
    schema: z.object({ action: z.enum(jevActions), blockIds: z.array(z.string()).max(20).optional(), query: z.string().max(4000).optional(),
      options: z.record(z.string(), z.json()).optional(), idempotencyKey: z.string().optional() }),
  })];
}
