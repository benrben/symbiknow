import type { ChatSettings, McpTokenInfo, WorkspaceSummary } from '../shared/types';

export function toolsForAccess(access: 'read' | 'propose' | 'write', catalog: ChatSettings['mcpToolCatalog'] = [],
  grants: Pick<McpTokenInfo, 'canApprove' | 'canConfigure'> = {}): string[] {
  return catalog.filter(tool => {
    if (tool.canApprove && !grants.canApprove) return false;
    if (tool.canConfigure && !grants.canConfigure) return false;
    return permitsAccess(access, tool.access);
  }).map(tool => tool.name);
}
function permitsAccess(access: 'read' | 'propose' | 'write', toolAccess: 'read' | 'propose' | 'write'): boolean {
  return toolAccess === 'read' || access === 'write' || (access === 'propose' && toolAccess === 'propose');
}
export function effectiveTokenScope(token: Pick<McpTokenInfo, 'access' | 'allowedCanvasIds' | 'tools'>, workspaces: WorkspaceSummary[] | null): string {
  const canvasIds = token.allowedCanvasIds;
  const canvases = Array.isArray(workspaces) ? workspaces.flatMap(workspace => workspace.canvases ?? []) : [];
  const canvasScope = !canvasIds ? 'All canvases' : `Canvases: ${canvasIds.map(id => canvases.find(canvas => canvas.id === id)?.name ?? id).join(', ')}`;
  const tools = token.tools;
  const access = token.access ?? 'write';
  const toolScope = !tools ? `All ${access} tools` : `Tools: ${tools.join(', ')}`;
  return `${canvasScope} · ${toolScope}`;
}
