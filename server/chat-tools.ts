import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { ApiError, CanvasStore } from './storage.js';
import type { AnswerSource, CanvasNavigationTarget, ChatViewContext, ResearchCanvasPatch } from '../shared/answer-canvas.js';
import { storedDocument } from '../shared/file-transfer.js';
import { groupLabel, groupPath, normalizedGroup } from '../shared/groups.js';
import type { BlockKind, CanvasDocument } from '../shared/types.js';
import { ChatProposalDraft } from './chat-proposals.js';
import { findBlock } from './chat-input.js';
import { jevChatTools } from './jev-chat-tools.js';

function canvasGroups(canvas: CanvasDocument): string[] {
  return [...new Set(canvas.blocks.flatMap(block => groupPath(normalizedGroup(block.group) ?? '__ungrouped')))];
}

function groupTitle(canvas: CanvasDocument, group: string): string {
  return canvas.groupLabels?.[group] ?? groupLabel(group);
}

function comparableName(name: string): string {
  return name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Models often name a group by its visible title; accept that as well as the stored key. */
function resolveGroup(canvas: CanvasDocument, requested: string): string | undefined {
  const groups = canvasGroups(canvas);
  if (groups.includes(requested)) return requested;
  const wanted = comparableName(requested);
  return groups.find(group => comparableName(groupTitle(canvas, group)) === wanted);
}

function groupChoices(canvas: CanvasDocument) {
  return canvasGroups(canvas).slice(0, 40).map(group => ({ group, title: groupTitle(canvas, group) }));
}

export type CanvasToolsOptions = {
  query: string;
  navigationRequests: CanvasNavigationTarget[];
  selectedSources: AnswerSource[];
  researchPatches: ResearchCanvasPatch[];
  draft: ChatProposalDraft;
  currentView?: ChatViewContext;
  signal?: AbortSignal;
};

export function canvasTools(store: CanvasStore, canvasId: string, options: CanvasToolsOptions): StructuredToolInterface[] {
  const { navigationRequests, selectedSources, researchPatches, draft, currentView } = options;
  return [
    tool(async ({ query }) => {
      const hits = await store.search(query);
      return JSON.stringify(hits);
    }, {
      name: 'search_docs', description: 'Search Markdown documents in all workspaces.',
      schema: z.object({ query: z.string().min(1) }),
    }),
    tool(async ({ blockId, sourceCanvasId }) => {
      const targetCanvasId = sourceCanvasId ?? canvasId;
      const block = targetCanvasId === canvasId ? draft.get(blockId) : await findBlock(store, targetCanvasId, blockId);
      return JSON.stringify(block);
    }, {
      name: 'read_doc', description: 'Read a Markdown block. Supply sourceCanvasId for a document on another canvas.',
      schema: z.object({ blockId: z.string().min(1), sourceCanvasId: z.string().min(1).optional() }),
    }),
    tool(async ({ blockId, sourceCanvasId }) => {
      const targetCanvasId = sourceCanvasId ?? canvasId;
      const targetCanvas = await store.getCanvas(targetCanvasId);
      const block = targetCanvas.blocks.find(item => item.id === blockId && !item.archived);
      if (!block) return JSON.stringify({ shown: false, reason: 'Document not found. Search for it with search_docs first.' });
      navigationRequests.push({ kind: 'document', canvasId: targetCanvasId, blockId, title: block.title });
      return JSON.stringify({ shown: true, canvasId: targetCanvasId, blockId, title: block.title });
    }, {
      name: 'show_doc_on_canvas', description: 'Move the user view to a document when they ask to see, open, find, or navigate to that document. This controls the visible app view; it does not edit the document.',
      schema: z.object({ blockId: z.string().min(1), sourceCanvasId: z.string().min(1).optional() }),
    }),
    tool(async ({ group: requested, sourceCanvasId }) => {
      const targetCanvasId = sourceCanvasId ?? canvasId;
      const targetCanvas = await store.getCanvas(targetCanvasId);
      const group = resolveGroup(targetCanvas, requested);
      // A missed name is recoverable: the model can pick from the real groups instead of failing the user's turn.
      if (!group) return JSON.stringify({ shown: false, reason: 'Group not found', availableGroups: groupChoices(targetCanvas) });
      const title = groupTitle(targetCanvas, group);
      navigationRequests.push({ kind: 'group', canvasId: targetCanvasId, group, title });
      return JSON.stringify({ shown: true, canvasId: targetCanvasId, group, title });
    }, {
      name: 'show_group_on_canvas', description: 'Move the user view to a group or subgroup when they ask to see, open, or navigate to it. Pass the group key or its visible title. This controls the visible app view; it does not edit documents.',
      schema: z.object({ group: z.string().min(1), sourceCanvasId: z.string().min(1).optional() }),
    }),
    tool(async ({ layout, blocks, edges }) => {
      const available = new Set(selectedSources.map(source => `${source.canvasId}:${source.blockId}`));
      const cleaned = blocks.map(block => ({ ...block, ...storedDocument({ kind: block.kind, content: block.content }),
        sourceIds: [...new Set(block.sourceIds.filter(id => available.has(id)))] }));
      const ids = new Set(cleaned.map(block => block.id));
      if (ids.size !== cleaned.length) throw new ApiError(400, 'Research block IDs must be unique');
      const validEdges = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);
      researchPatches.push({ query: options.query, layout, blocks: cleaned, edges: validEdges });
      return JSON.stringify({ drawn: true, blocks: cleaned.length, edges: validEdges.length });
    }, {
      name: 'draw_research_canvas', description: 'Draw a session research answer using the same document formats as the main canvas. Each block has a semantic type and optional loader kind: markdown (prose, images with Markdown image URLs, Mermaid diagrams, tables, tasks, video links), html (a complete HTML page), slides (Marp), mdx (supported Chart or Calculator components), or website (existing documentation site folder). Cite selected sources with sourceIds. Connect blocks with meaningful edges.',
      schema: z.object({ layout: z.enum(['roadmap', 'kanban', 'architecture', 'mindmap']).optional(),
        blocks: z.array(z.object({ id: z.string().min(1).max(64), type: z.enum(['text', 'diagram', 'task', 'section']),
          kind: z.enum(['markdown', 'html', 'slides', 'website', 'mdx']).optional(),
          title: z.string().min(1).max(160), content: z.string().min(1).max(20_000), sourceIds: z.array(z.string()).max(12),
          lane: z.string().max(64).optional() })).min(1).max(12),
        edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().max(80).optional() })).max(24) }),
    }),
    tool(async args => {
      const document = storedDocument(args);
      return JSON.stringify({ ...draft.create({ ...document, title: args.title, kind: document.kind as BlockKind | undefined,
        x: args.x, y: args.y }), proposed: true, saved: false });
    }, {
      name: 'create_doc', description: 'Create a block on the active canvas. Choose markdown for prose, image URLs, Mermaid diagrams, tables, tasks, and video links; html for a full HTML page; slides for Marp; mdx for supported Chart or Calculator components; website only for an existing documentation site folder.',
      schema: z.object({ title: z.string().min(1), content: z.string(), kind: z.enum(['markdown', 'html', 'slides', 'website', 'mdx']).optional(),
        x: z.number().finite().optional(), y: z.number().finite().optional() }),
    }),
    tool(async ({ blockId, ...patch }) => {
      if (currentView?.editingBlockId === blockId && currentView.editorHasUnsavedChanges) {
        throw new ApiError(409, 'Save or discard your unsaved editor changes before Symbi edits this document.');
      }
      draft.get(blockId);
      const document = storedDocument(patch);
      return JSON.stringify({ ...draft.patch(blockId, { ...document, kind: document.kind as BlockKind | undefined }, 'edit'), proposed: true, saved: false });
    }, {
      name: 'edit_doc', description: 'Edit a block title, complete source, or loader. For an HTML page, supply kind html and the full HTML source.',
      schema: z.object({ blockId: z.string().min(1), title: z.string().optional(), content: z.string().optional(),
        kind: z.enum(['markdown', 'html', 'slides', 'website', 'mdx']).optional() }),
    }),
    tool(async ({ blockId, x, y }) => JSON.stringify({ ...draft.patch(blockId, { x, y }, 'move'), proposed: true, saved: false }), {
      name: 'move_block', description: 'Move a block to coordinates on the infinite canvas.',
      schema: z.object({ blockId: z.string().min(1), x: z.number().finite(), y: z.number().finite() }),
    }),
    tool(async ({ fromBlockId, toBlockId, relation }) => {
      const from = draft.get(fromBlockId);
      draft.get(toBlockId);
      return JSON.stringify({ ...draft.patch(fromBlockId, {
        links: [...new Set([...from.links, toBlockId])],
        ...(relation ? { linkTypes: { ...from.linkTypes, [toBlockId]: relation } } : {}),
      }, 'link'), proposed: true, saved: false });
    }, {
      name: 'link_blocks', description: 'Link one block to another block on the active canvas. For a new document that depends on a source, link from the new document to the source with relation prerequisite.',
      schema: z.object({ fromBlockId: z.string().min(1), toBlockId: z.string().min(1),
        relation: z.enum(['prerequisite', 'implements', 'decision_for', 'supersedes', 'contradicts', 'example_of', 'same_topic', 'related']).optional() }),
    }),
    ...jevChatTools(store, canvasId),
  ];
}
