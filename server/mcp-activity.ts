import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type McpAccess = 'read' | 'propose' | 'write';
export type McpActivityEntry = {
  id: string;
  tokenId: string;
  tokenName: string;
  access: McpAccess;
  allowedCanvasIds?: string[];
  tools?: string[];
  tool: string;
  startedAt: string;
  endedAt: string;
  outcome: 'success' | 'error' | 'denied';
  error?: string;
  canvasIds: string[];
  documentIds: string[];
  revision?: string;
};

export type McpActivityInput = Omit<McpActivityEntry, 'id'>;
const limit = 500;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const revisionPattern = /^[0-9a-f]{40}$/i;

function ids(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && idPattern.test(value)))].slice(0, 20);
}

/** Reads only known ID fields. Arguments can contain complete documents and token-like strings. */
export function mcpActivityRefs(args: unknown): { canvasIds: string[]; documentIds: string[] } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { canvasIds: [], documentIds: [] };
  const input = args as Record<string, unknown>;
  return {
    canvasIds: ids([input.canvasId, input.sourceCanvasId, input.targetCanvasId]),
    documentIds: ids([input.blockId, input.fromBlockId, input.toBlockId, input.keepBlockId,
      ...(Array.isArray(input.blockIds) ? input.blockIds : []), ...(Array.isArray(input.mergeBlockIds) ? input.mergeBlockIds : [])]),
  };
}

function matchingString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function firstRevision(commits: Array<{ id?: unknown }> | undefined): string | undefined {
  return matchingString(commits?.[0]?.id, revisionPattern);
}

export function mcpResultIds(result: unknown): { documentId?: string; revision?: string } {
  if (!result || typeof result !== 'object') return {};
  const content = (result as { content?: Array<{ text?: unknown }> }).content;
  const text = content?.[0]?.text;
  if (typeof text !== 'string') return {};
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const status = value.status as { commits?: Array<{ id?: unknown }> } | undefined;
    const commits = value.commits as Array<{ id?: unknown }> | undefined;
    return { documentId: matchingString(value.id, idPattern),
      revision: firstRevision(status?.commits) ?? firstRevision(commits) };
  } catch { return {}; }
}

export function safeMcpError(outcome: 'error' | 'denied', reason?: unknown): string {
  if (outcome === 'denied') return 'Token access does not permit this tool.';
  const message = reason instanceof Error ? reason.message : '';
  const status = /\((4\d\d|5\d\d)\)/.exec(message);
  if (status) return 'Canvas API request failed (' + status[1] + ').';
  if (message.includes('unavailable')) return 'Canvas API was unavailable.';
  return 'Tool call failed. Review its arguments or retry.';
}

export async function readMcpActivity(file: string): Promise<{ entries: McpActivityEntry[] }> {
  try {
    const entries = JSON.parse(await readFile(file, 'utf8')) as McpActivityEntry[];
    if (!Array.isArray(entries)) throw new Error('MCP activity file is invalid');
    return { entries };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
    throw error;
  }
}

export async function appendMcpActivity(file: string, input: McpActivityInput): Promise<McpActivityEntry> {
  const entry = { ...input, id: randomUUID() };
  const previous = await readMcpActivity(file);
  const temporary = file + '.' + randomUUID() + '.tmp';
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify([entry, ...previous.entries].slice(0, limit)), { mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally { await rm(temporary, { force: true }); }
  return entry;
}
