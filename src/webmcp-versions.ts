import { api } from './api';
import type { ToolResult } from './webmcp-types';
import { changed } from './webmcp-context';
import { canvasIdFrom, path, requiredString, textResult } from './webmcp-arguments';

export function versionOperation(route: string, field: 'name' | 'revision') {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const base = path(canvasIdFrom(args), requiredString(args, 'blockId')) + '/versions';
    const result = await api(`${base}/${route}`, { method: 'POST',
      body: JSON.stringify({ [field]: requiredString(args, field) }) });
    if (route !== 'branches') changed();
    return textResult(result);
  };
}
