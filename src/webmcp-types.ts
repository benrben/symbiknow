export type JsonSchema = { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
export type ToolResult = { content: Array<{ type: string; text?: string; [key: string]: unknown }>; isError?: boolean; structuredContent?: Record<string, unknown> };
export type CanonicalTool = { name: string; description?: string; inputSchema: JsonSchema; annotations?: { readOnlyHint?: boolean }; _meta?: Record<string, unknown> };
export type WebMCPInstance = {
  registerTool(name: string, description: string, schema: JsonSchema, execute: (args: Record<string, unknown>) => Promise<ToolResult>): void;
  registerResource(name: string, description: string, template: { uri: string; mimeType: string }, read: (uri: string) => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }>): void;
};
export type WebMCPConstructor = new (options?: Record<string, unknown>) => WebMCPInstance;

declare global { interface Window { WebMCP?: WebMCPConstructor } }
