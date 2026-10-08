import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AnswerSource } from '../shared/answer-canvas.js';
import { normalizeEvidence } from '../shared/evidence.js';
import type { CanvasBlock } from '../shared/types.js';
import { mcpResultValue } from './mcp-client-tools.js';
import type { SymbiToolContext } from './symbi-mcp-client.js';

function canvasName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

async function readCanvasName(client: Client, id: string, signal?: AbortSignal): Promise<string> {
  try {
    const output = await client.callTool({ name: 'read_canvas', arguments: { canvasId: id, includeContent: false } }, undefined, { signal });
    if (output.isError) return id;
    return canvasName(mcpResultValue(output as { content?: unknown; structuredContent?: unknown })) ?? id;
  } catch {
    signal?.throwIfAborted();
    return id;
  }
}

function readSource(document: CanvasBlock, id: string, name: string, context: SymbiToolContext): AnswerSource {
  const excerpt = document.content.slice(0, 300).trim();
  const start = document.content.indexOf(excerpt);
  const evidence = normalizeEvidence({ claim: `Source read for: ${context.query}`, passage: excerpt,
    sourceText: document.content, canvasId: id, documentId: document.id, documentTitle: document.title,
    contentHash: document.contentHash, start, end: start + excerpt.length, checkedAt: new Date().toISOString() });
  return { canvasId: id, canvasName: name, blockId: document.id, title: document.title,
    excerpt, relevance: 1, contentHash: document.contentHash, ...(evidence ? { evidence } : {}) };
}

function readDocument(value: unknown, input: Record<string, unknown>): CanvasBlock | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const document = value as CanvasBlock;
  if (document.id !== input.blockId || typeof document.content !== 'string' || typeof document.title !== 'string') return undefined;
  return document;
}

function rememberCanvas(names: Map<string, Promise<string>>, id: string, value: unknown): void {
  const title = canvasName(value);
  if (title) names.set(id, Promise.resolve(title));
}

function sourceCanvasName(client: Client, names: Map<string, Promise<string>>, id: string, signal?: AbortSignal): Promise<string> {
  const title = names.get(id) ?? readCanvasName(client, id, signal);
  names.set(id, title);
  return title;
}

function rememberSource(context: SymbiToolContext, source: AnswerSource): void {
  const sources = context.readSources ??= [];
  const previous = sources.findIndex(item => item.canvasId === source.canvasId && item.blockId === source.blockId);
  if (previous < 0) sources.push(source);
  else sources[previous] = source;
}

/** Source citations come from successful canonical reads, including reads made after retrieval. */
export async function recordMcpRead(client: Client, name: string, input: Record<string, unknown>, value: unknown,
  context: SymbiToolContext, signal?: AbortSignal): Promise<void> {
  if (typeof input.canvasId !== 'string') return;
  const names = context.canvasNames ??= new Map();
  if (name === 'read_canvas') {
    rememberCanvas(names, input.canvasId, value);
    return;
  }
  if (name !== 'read_doc') return;
  const document = readDocument(value, input);
  if (!document) return;
  const title = await sourceCanvasName(client, names, input.canvasId, signal);
  rememberSource(context, readSource(document, input.canvasId, title, context));
}
