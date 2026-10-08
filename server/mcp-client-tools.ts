import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** Discovery must follow every page; granted tools must never silently disappear. */
export async function discoverMcpTools(client: Client, signal?: AbortSignal): Promise<Tool[]> {
  const tools: Tool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('MCP tool discovery returned a repeated pagination cursor.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return tools;
}

export function mcpResultValue(output: { content?: unknown; structuredContent?: unknown }): unknown {
  if (output.structuredContent !== undefined) return output.structuredContent;
  if (Array.isArray(output.content)) {
    const text = output.content.filter(part => part?.type === 'text').map(part => part.text).join('\n');
    try { return JSON.parse(text); } catch { return text; }
  }
  return output.content;
}
