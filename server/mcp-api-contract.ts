import { z } from 'zod';
import { projectMcpDefinitions, type McpToolDefinition } from './mcp-registry.js';

export type ApiRouteContract = { method: string; path: string; bodyFields?: string[];
  equals?: Record<string, string>; queryEquals?: Record<string, string> };
type CompiledContract = { tool: McpToolDefinition; route: ApiRouteContract; pattern: RegExp; params: string[];
  paramSchema: z.ZodObject; bodySchema?: z.ZodObject };
let compiled: CompiledContract[] | undefined;
function compile(tool: McpToolDefinition, route: ApiRouteContract): CompiledContract {
  const params: string[] = [];
  const pattern = route.path.split('/').map(part => {
    if (part.startsWith(':')) { params.push(part.slice(1)); return '([^/]+)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const shape = tool.config.inputSchema ?? {};
  const paramSchema = z.object(Object.fromEntries(params.filter(name => shape[name]).map(name => [name, shape[name]])));
  const bodySchema = route.bodyFields ? z.object(Object.fromEntries(route.bodyFields.map(name =>
    [name, route.equals?.[name] !== undefined ? z.literal(route.equals[name]) : shape[name] ?? z.unknown()]))).strict() : undefined;
  return { tool, route, pattern: new RegExp(`^/api${pattern}$`), params, paramSchema, bodySchema };
}
export function apiContracts() {
  compiled ??= projectMcpDefinitions().flatMap(toolApiContracts);
  return compiled;
}
export function toolApiContracts(tool: McpToolDefinition) {
  const routes = tool.config._meta?.apiRoutes;
  if (!Array.isArray(routes) || !routes.length) throw new Error(`MCP tool ${tool.name} has no API authorization contract`);
  return (routes as ApiRouteContract[]).map(route => compile(tool, route));
}
function matchesOperation(contract: CompiledContract, method: string, declared?: string) {
  return contract.route.method === method && (!declared || contract.tool.name === declared);
}
function matchesQuery(contract: CompiledContract, query: URLSearchParams) {
  return Object.entries(contract.route.queryEquals ?? {}).every(([key, value]) => query.get(key) === value);
}
export function matchingApiContracts(method: string, pathname: string, query: URLSearchParams, declared?: string) {
  return apiContracts().flatMap(contract => {
    if (!matchesOperation(contract, method, declared)) return [];
    const match = pathname.match(contract.pattern);
    if (!match || !matchesQuery(contract, query)) return [];
    const params = Object.fromEntries(contract.params.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
    if (!contract.paramSchema.safeParse(params).success) return [];
    return [{ ...contract, params }];
  });
}
