// Frozen Atlas filing answer keys, shared without loading credentials or synthetic documents.
export const groups = [
  { key: 'custom:search', name: 'Search and retrieval', definition: 'Finding knowledge: the search index, ranking, embeddings, and the ask and claim-check tools', members: ['search-and-brain-tools'] },
  { key: 'custom:reflex', name: 'Symbi Reflex engine', definition: 'The Symbi Reflex automatic organizer, the Jev decision engine, and its SDK', members: ['symbi-reflex', 'reflex-internals', 'sdk-and-webmcp'] },
  { key: 'custom:chat', name: 'Chat assistant', definition: 'The chat assistant, its agent tools, proposals, and the research canvas', members: ['assistant-and-research', 'chat-internals'] },
  { key: 'custom:documents', name: 'Documents and collaboration', definition: 'Editing documents safely together, Git history, imports, moving, and the data model', members: ['safe-collaboration', 'document-operations', 'data-model'] },
  { key: 'custom:security', name: 'Security and access', definition: 'Tokens, MCP connections, principals, and secrets', members: ['security-and-access', 'mcp-and-api'] },
  { key: 'custom:interface', name: 'Interface and brand', definition: 'The canvas interface, brand, theme, and visual design', members: ['brand-and-ui', 'canvas-ui'] },
  { key: 'custom:engineering', name: 'Engineering', definition: 'Architecture, running and testing the app, errors, project history, and plans', members: ['architecture', 'operations', 'testing', 'errors', 'history', 'plan-status'] },
];
// Declared before running: debatable documents and their acceptable groups.
export const alternates: Record<string, string[]> = { 'sdk-and-webmcp': ['custom:reflex', 'custom:security'], 'mcp-and-api': ['custom:security', 'custom:search'],
  architecture: ['custom:engineering', 'custom:documents'], 'plan-status': ['custom:engineering', 'custom:reflex'] };
