import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpAccess } from './mcp-activity.js';
import type { ProjectMcpOptions } from './mcp-options.js';

export type McpHttpSession = { transport: StreamableHTTPServerTransport; close: () => Promise<void>;
  seen: number; tokenId: string; storeRoot: string; localPort: number | undefined };
export type McpHttpIdentity = { id: string; name: string; access: McpAccess; allowedCanvasIds?: string[]; tools?: string[];
  canApprove?: boolean; canConfigure?: boolean };
export type McpHttpToolCall = { name: string; args: unknown };
export type McpHttpToolEvent = Parameters<NonNullable<ProjectMcpOptions['onToolCall']>>[0];
export type McpHttpBody = { ok: true; value: unknown } | { ok: false };
