export type SchemaProperty = { type: string; description?: string; enum?: string[]; items?: SchemaProperty; additionalProperties?: SchemaProperty };
export type JsonSchema = { type: 'object'; properties: Record<string, SchemaProperty>; required?: string[] };
export type ToolResult = { content: { type: 'text'; text: string }[] };
export type WebMCPInstance = {
  registerTool(name: string, description: string, schema: JsonSchema, execute: (args: Record<string, unknown>) => Promise<ToolResult>): void;
  registerResource(name: string, description: string, template: { uri: string; mimeType: string }, read: (uri: string) => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }>): void;
};
export type WebMCPConstructor = new (options?: Record<string, unknown>) => WebMCPInstance;

declare global { interface Window { WebMCP?: WebMCPConstructor } }
