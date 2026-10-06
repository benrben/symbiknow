import type { McpTokenInfo, WorkspaceSummary } from '../shared/types';

const readMcpTools = ['list_canvases', 'read_canvas', 'search_docs', 'read_doc', 'download_file', 'list_versions'];
const writeMcpTools = ['list_canvases', 'read_canvas', 'search_docs', 'read_doc', 'create_doc', 'edit_doc', 'delete_doc', 'move_block',
  'link_blocks', 'unlink_blocks', 'upload_file', 'download_file', 'claim_doc', 'release_doc',
  'list_versions', 'create_branch', 'switch_branch', 'merge_branch', 'restore_revision'];
const readJevTools = ['jev_profile', 'find_by', 'related', 'memory_map', 'jev_activity', 'brain_inbox', 'jev_job'];
export function toolsForAccess(access: 'read' | 'propose' | 'write'): string[] {
  if (access === 'write') return [...writeMcpTools, ...readJevTools, 'jev_do', 'jev_propose'];
  return access === 'propose' ? [...readMcpTools, ...readJevTools, 'jev_propose'] : [...readMcpTools, ...readJevTools];
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
