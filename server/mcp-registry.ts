import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CanvasApi } from './mcp-api.js';
import { registerDocumentTools, registerCoordinationTools, registerVersionTools } from './mcp-tools.js';
import { registerFileTools } from './mcp-file-tools.js';
import { registerFileProposalTools } from './mcp-file-proposal-tools.js';
import { registerJevTools } from './mcp-jev-tools.js';
import { registerSymbiBrainTools } from './mcp-brain-tools.js';
import { registerTodoTools } from './mcp-todo-tools.js';
import { registerPresentationTools } from './mcp-presentation-tools.js';

export type McpPermission = 'read' | 'propose' | 'write' | 'approve' | 'configure';
export type McpToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};
export type McpToolDefinition = {
  name: string;
  config: McpToolConfig;
  handler: (...args: unknown[]) => unknown;
};

export function toolPermission(config: McpToolConfig): McpPermission {
  const declared = config._meta?.permission;
  if (['read', 'propose', 'write', 'approve', 'configure'].includes(String(declared))) return declared as McpPermission;
  return config.annotations?.readOnlyHint ? 'read' : 'write';
}

/** Schemas, descriptions, policy and handlers are collected from the same registrations. */
export function projectMcpTools(api: CanvasApi, localFiles: boolean): McpToolDefinition[] {
  return collectMcpTools(collector => {
    registerDocumentTools(collector, api);
    registerFileTools(collector, api, localFiles);
    registerFileProposalTools(collector, api);
    registerCoordinationTools(collector, api);
    registerTodoTools(collector, api);
    registerVersionTools(collector, api);
    registerSymbiBrainTools(collector, api);
    registerJevTools(collector, api);
    registerPresentationTools(collector, api);
  });
}

export function collectMcpTools(register: (collector: McpServer) => void): McpToolDefinition[] {
  const definitions: McpToolDefinition[] = [];
  const collector = { registerTool(name: string, config: McpToolConfig, handler: McpToolDefinition['handler']) {
    if (definitions.some(tool => tool.name === name)) throw new Error(`Duplicate MCP tool: ${name}`);
    if (!config.description?.trim()) throw new Error(`MCP tool ${name} needs a description`);
    definitions.push({ name, config, handler });
  } } as unknown as McpServer;
  register(collector);
  return definitions;
}

let definitions: McpToolDefinition[] | undefined;
export function projectMcpDefinitions() {
  definitions ??= projectMcpTools(new CanvasApi('', fetch, {}), false);
  return definitions;
}

let metadata: Array<{ name: string; description: string; permission: McpPermission; documentResult: boolean }> | undefined;
export function projectMcpMetadata() {
  metadata ??= projectMcpDefinitions().map(({ name, config }) => ({
    name, description: config.description!, permission: toolPermission(config), documentResult: config._meta?.documentResult === true,
  }));
  return metadata;
}

export function advertisedTool({ name, config }: McpToolDefinition) {
  return { name, title: config.title, description: config.description,
    inputSchema: z.toJSONSchema(z.object(config.inputSchema ?? {}), { io: 'input' }),
    annotations: config.annotations, _meta: config._meta };
}
