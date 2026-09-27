import webmcpUrl from '@jason.today/webmcp/src/webmcp.js?url';
import { api } from './api';
import { storedDocument, uploadedSource } from '../shared/file-transfer';
import type { CanvasBlock, CanvasDocument } from '../shared/types';

type SchemaProperty = { type: string; description?: string; enum?: string[]; items?: SchemaProperty; additionalProperties?: SchemaProperty };
type JsonSchema = { type: 'object'; properties: Record<string, SchemaProperty>; required?: string[] };
type ToolResult = { content: { type: 'text'; text: string }[] };
type WebMCPInstance = {
  registerTool(name: string, description: string, schema: JsonSchema, execute: (args: Record<string, unknown>) => Promise<ToolResult>): void;
  registerResource(name: string, description: string, template: { uri: string; mimeType: string }, read: (uri: string) => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }>): void;
};
type WebMCPConstructor = new (options?: Record<string, unknown>) => WebMCPInstance;

declare global { interface Window { WebMCP?: WebMCPConstructor } }

let scriptPromise: Promise<void> | null = null;
let libraryLoaded = false;
let instance: WebMCPInstance | null = null;
let activeCanvas: () => string = () => '';
let changed: () => void = () => {};

function appendScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}.`));
    document.head.appendChild(script);
  });
}

async function loadWebMCP(): Promise<void> {
  if (!libraryLoaded) {
    await appendScript(webmcpUrl);
    libraryLoaded = true;
  }
  await appendScript('/webmcp-adapter.js');
  if (!window.WebMCP) throw new Error('WebMCP did not initialize.');
}

function loadScript(): Promise<void> {
  if (window.WebMCP) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = loadWebMCP().catch(error => {
      scriptPromise = null;
      throw error;
    });
  }
  return scriptPromise;
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function canvasIdFrom(args: Record<string, unknown>) {
  const id = typeof args.canvasId === 'string' && args.canvasId.trim() ? args.canvasId.trim() : activeCanvas();
  if (!id) throw new Error('Open a canvas before using this tool, or provide canvasId.');
  return id;
}

function requiredString(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' is required.');
  return value.trim();
}

function requiredStrings(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(name + ' must be a nonempty array of strings.');
  }
  return value as string[];
}

function path(canvasId: string, blockId?: string) {
  const base = '/canvases/' + encodeURIComponent(canvasId) + '/blocks';
  return blockId ? base + '/' + encodeURIComponent(blockId) : base;
}

async function searchDocs(args: Record<string, unknown>): Promise<ToolResult> {
  if (args.rank !== undefined && args.rank !== 'jev') throw new Error('rank must be jev when provided.');
  return textResult(await api('/search?q=' + encodeURIComponent(requiredString(args, 'query')) + (args.rank === 'jev' ? '&rank=jev' : '')));
}

async function findDuplicates(args: Record<string, unknown>): Promise<ToolResult> {
  const canvasId = canvasIdFrom(args);
  const blockId = args.blockId === undefined ? undefined : requiredString(args, 'blockId');
  if (args.crossCanvas !== undefined && typeof args.crossCanvas !== 'boolean') throw new Error('crossCanvas must be a boolean.');
  return textResult(await api('/canvases/' + encodeURIComponent(canvasId) + '/duplicates', {
    method: 'POST', body: JSON.stringify({ ...(blockId ? { blockId } : {}), crossCanvas: args.crossCanvas ?? false }),
  }));
}

async function connectAcrossCanvases(args: Record<string, unknown>): Promise<ToolResult> {
  return textResult(await api('/canvases/' + encodeURIComponent(canvasIdFrom(args)) + '/cross-connections', {
    method: 'POST', body: JSON.stringify({}),
  }));
}

async function scoreDocuments(args: Record<string, unknown>): Promise<ToolResult> {
  return textResult(await api('/canvases/' + encodeURIComponent(canvasIdFrom(args)) + '/quality', {
    method: 'POST', body: JSON.stringify({}),
  }));
}

async function mergeDocuments(args: Record<string, unknown>): Promise<ToolResult> {
  const canvasId = canvasIdFrom(args);
  const keepBlockId = requiredString(args, 'keepBlockId');
  const mergeBlockIds = requiredStrings(args, 'mergeBlockIds');
  if (typeof args.content !== 'string') throw new Error('content must contain the complete merged source.');
  const hashes = args.expectedContentHashes;
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) throw new Error('expectedContentHashes is required.');
  const expectedContentHashes = hashes as Record<string, unknown>;
  for (const blockId of [keepBlockId, ...mergeBlockIds]) {
    if (typeof expectedContentHashes[blockId] !== 'string' || !expectedContentHashes[blockId]) {
      throw new Error(`Missing expectedContentHash for ${blockId}`);
    }
  }
  const result = await api('/canvases/' + encodeURIComponent(canvasId) + '/merge', {
    method: 'POST', body: JSON.stringify({ keepBlockId, mergeBlockIds, content: args.content, expectedContentHashes }),
  });
  changed();
  return textResult(result);
}

async function moveDocument(args: Record<string, unknown>): Promise<ToolResult> {
  const route = path(canvasIdFrom(args), requiredString(args, 'blockId')) + '/move';
  const result = await api(route, { method: 'POST', body: JSON.stringify({ targetCanvasId: requiredString(args, 'targetCanvasId') }) });
  changed();
  return textResult(result);
}

const workspaceKinds = ['layout', 'connection', 'regroup', 'purpose', 'work_area', 'reviewer',
  'cross_connect', 'dedupe', 'tidy', 'connect_all'];

async function runWorkspaceAutomation(args: Record<string, unknown>): Promise<ToolResult> {
  const workspaceId = requiredString(args, 'workspaceId');
  const kind = requiredString(args, 'kind');
  if (!workspaceKinds.includes(kind)) throw new Error('Unknown workspace automation kind.');
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be a boolean.');
  const dryRun = args.dryRun !== false;
  const runId = args.runId === undefined ? undefined : requiredString(args, 'runId');
  const actionIds = dryRun ? undefined : requiredStrings(args, 'actionIds');
  const result = await api('/workspaces/' + encodeURIComponent(workspaceId) + '/automations', {
    method: 'POST', body: JSON.stringify({ kind, dryRun, ...(runId ? { runId } : {}), ...(actionIds ? { actionIds } : {}) }),
  });
  if (!dryRun) changed();
  return textResult(result);
}

async function undoJevRun(args: Record<string, unknown>): Promise<ToolResult> {
  const runId = requiredString(args, 'runId');
  const result = await api('/jev-runs/' + encodeURIComponent(runId) + '/undo', { method: 'POST', body: JSON.stringify({}) });
  changed();
  return textResult(result);
}

async function undoMerge(args: Record<string, unknown>): Promise<ToolResult> {
  const mergeId = requiredString(args, 'mergeId');
  const result = await api('/merges/' + encodeURIComponent(mergeId) + '/undo', { method: 'POST', body: JSON.stringify({}) });
  changed();
  return textResult(result);
}

async function openDoc(args: Record<string, unknown>): Promise<ToolResult> {
  const blockId = requiredString(args, 'blockId');
  const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(canvasIdFrom(args)));
  const block = document.blocks.find(item => item.id === blockId);
  if (!block) throw new Error('Document not found.');
  return textResult(block);
}

function blockKind(args: Record<string, unknown>): string {
  const allowed = ['markdown', 'html', 'slides', 'website', 'mdx'];
  return typeof args.kind === 'string' && allowed.includes(args.kind) ? args.kind : 'markdown';
}

async function createDoc(args: Record<string, unknown>): Promise<ToolResult> {
  const block = await api<CanvasBlock>(path(canvasIdFrom(args)), {
    method: 'POST',
    body: JSON.stringify(storedDocument({
      title: requiredString(args, 'title'), content: String(args.content ?? ''),
      kind: blockKind(args), x: args.x, y: args.y,
    })),
  });
  changed();
  return textResult(block);
}

async function uploadFile(args: Record<string, unknown>): Promise<ToolResult> {
  if (typeof args.content !== 'string') throw new Error('content must contain the entire file source.');
  const source = uploadedSource(requiredString(args, 'filename'), args.content);
  const canvasId = canvasIdFrom(args);
  const blockId = typeof args.blockId === 'string' && args.blockId.trim() ? args.blockId.trim() : undefined;
  const title = args.title === undefined ? source.title : requiredString(args, 'title');
  const route = path(canvasId, blockId);
  const block = await api<CanvasBlock>(route, { method: blockId ? 'PUT' : 'POST',
    body: JSON.stringify(blockId ? { content: source.content, kind: source.kind, ...(args.title === undefined ? {} : { title }) }
      : { title, content: source.content, kind: source.kind, x: args.x, y: args.y }),
  });
  changed();
  return textResult({ ...block, overwritten: Boolean(blockId) });
}

async function downloadFile(args: Record<string, unknown>): Promise<ToolResult> {
  const blockId = requiredString(args, 'blockId');
  const canvas = await api<CanvasDocument>('/canvases/' + encodeURIComponent(canvasIdFrom(args)));
  const block = canvas.blocks.find(item => item.id === blockId);
  if (!block) throw new Error('Document not found.');
  return textResult({ blockId, filename: block.file.split('/').at(-1), title: block.title,
    kind: block.kind, content: block.content });
}

function editPatch(args: Record<string, unknown>): Record<string, unknown> {
  const patch = Object.fromEntries(['title', 'content', 'kind']
    .filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  if (!Object.keys(patch).length) throw new Error('Provide a title, content, or kind to edit.');
  return patch;
}

async function editDoc(args: Record<string, unknown>): Promise<ToolResult> {
  const block = await api<CanvasBlock>(path(canvasIdFrom(args), requiredString(args, 'blockId')), {
    method: 'PUT', body: JSON.stringify(storedDocument(editPatch(args))),
  });
  changed();
  return textResult(block);
}

async function removeDoc(args: Record<string, unknown>): Promise<ToolResult> {
  const result = await api(path(canvasIdFrom(args), requiredString(args, 'blockId')), { method: 'DELETE' });
  changed();
  return textResult(result);
}

function requiredCoordinate(args: Record<string, unknown>, key: 'x' | 'y'): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('x and y must be finite numbers.');
  return value;
}

async function moveBlock(args: Record<string, unknown>): Promise<ToolResult> {
  const x = requiredCoordinate(args, 'x');
  const y = requiredCoordinate(args, 'y');
  const block = await api<CanvasBlock>(path(canvasIdFrom(args), requiredString(args, 'blockId')), {
    method: 'PUT', body: JSON.stringify({ x, y }),
  });
  changed();
  return textResult(block);
}

async function analyzeCanvas(args: Record<string, unknown>): Promise<ToolResult> {
  const canvasId = canvasIdFrom(args);
  const query = typeof args.query === 'string' ? args.query : '';
  return textResult(await api('/canvases/' + encodeURIComponent(canvasId) + '/insights', {
    method: 'POST', body: JSON.stringify({ query }),
  }));
}

function jevAutomation(kind: 'layout' | 'connection' | 'regroup' | 'purpose' | 'work_area' | 'reviewer' | 'cross_connect') {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const canvasId = canvasIdFrom(args);
    const groupBy = ['work_area', 'purpose', 'lane'].includes(String(args.groupBy)) ? args.groupBy : undefined;
    const result = await api('/canvases/' + encodeURIComponent(canvasId) + '/automations', {
      method: 'POST', body: JSON.stringify({ kind, ...(groupBy ? { groupBy } : {}) }),
    });
    changed();
    return textResult(result);
  };
}

function versionOperation(route: string, field: 'name' | 'revision') {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const base = path(canvasIdFrom(args), requiredString(args, 'blockId')) + '/versions';
    const result = await api(`${base}/${route}`, { method: 'POST',
      body: JSON.stringify({ [field]: requiredString(args, field) }) });
    if (route !== 'branches') changed();
    return textResult(result);
  };
}

async function readActiveCanvas(uri: string): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(canvasIdFrom({})));
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(document) }] };
}

function registerTools(mcp: WebMCPInstance) {
  mcp.registerTool('search_docs', 'Search Markdown documents in all workspaces.', {
    type: 'object', properties: { query: { type: 'string', description: 'Text to search for' },
      rank: { type: 'string', enum: ['jev'], description: 'Optionally rerank the first 20 hits by Jev relevance' } }, required: ['query'],
  }, searchDocs);

  mcp.registerTool('open_doc', 'Read a Markdown block and its metadata.', {
    type: 'object', properties: { canvasId: { type: 'string', description: 'Defaults to the active canvas' }, blockId: { type: 'string' } }, required: ['blockId'],
  }, openDoc);

  mcp.registerTool('create_doc', 'Create a canvas block using Markdown, HTML, Marp slides, an existing documentation website, or supported MDX components. Markdown can embed images and Mermaid diagrams.', {
    type: 'object', properties: {
      canvasId: { type: 'string', description: 'Defaults to the active canvas' },
      title: { type: 'string' }, content: { type: 'string' },
      kind: { type: 'string', enum: ['markdown', 'html', 'slides', 'website', 'mdx'] },
      x: { type: 'number' }, y: { type: 'number' },
    }, required: ['title', 'content'],
  }, createDoc);

  mcp.registerTool('upload_file', 'Create a document from a complete .md, .mdx, or .html file, or replace every byte of an existing document by blockId.', {
    type: 'object', properties: { canvasId: { type: 'string' }, blockId: { type: 'string', description: 'Provide to overwrite an existing document' },
      filename: { type: 'string' }, content: { type: 'string', description: 'Complete file source' }, title: { type: 'string' },
      x: { type: 'number' }, y: { type: 'number' } }, required: ['filename', 'content'],
  }, uploadFile);

  mcp.registerTool('download_file', 'Get the complete saved Markdown source and filename for a document.', {
    type: 'object', properties: { canvasId: { type: 'string' }, blockId: { type: 'string' } }, required: ['blockId'],
  }, downloadFile);

  mcp.registerTool('edit_doc', 'Edit the title, full source, or loader of a canvas block. Use kind html with complete HTML source for a full page.', {
    type: 'object', properties: {
      canvasId: { type: 'string', description: 'Defaults to the active canvas' },
      blockId: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
      kind: { type: 'string', enum: ['markdown', 'html', 'slides', 'website', 'mdx'] },
    }, required: ['blockId'],
  }, editDoc);

  mcp.registerTool('remove_doc', 'Remove a Markdown block and its file.', {
    type: 'object', properties: {
      canvasId: { type: 'string', description: 'Defaults to the active canvas' },
      blockId: { type: 'string' },
    }, required: ['blockId'],
  }, removeDoc);

  mcp.registerTool('move_block', 'Set a block position on the infinite canvas.', {
    type: 'object', properties: {
      canvasId: { type: 'string', description: 'Defaults to the active canvas' },
      blockId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
    }, required: ['blockId', 'x', 'y'],
  }, moveBlock);

  mcp.registerTool('move_document', 'Move a document to another canvas in the same workspace while preserving its history.', {
    type: 'object', properties: { canvasId: { type: 'string', description: 'Defaults to the active canvas' },
      blockId: { type: 'string' }, targetCanvasId: { type: 'string' } }, required: ['blockId', 'targetCanvasId'],
  }, moveDocument);

  const canvasSchema: JsonSchema = { type: 'object', properties: {
    canvasId: { type: 'string', description: 'Defaults to the active canvas' },
  } };
  mcp.registerTool('analyze_canvas', 'Ask TypeSafe Jev to rank documents and suggest canvas changes without applying them.', {
    type: 'object', properties: { ...canvasSchema.properties, query: { type: 'string', description: 'Optional focus phrase' } },
  }, analyzeCanvas);
  mcp.registerTool('find_duplicates', 'Find duplicate documents and reviewable merge plans without changing saved files.', {
    type: 'object', properties: { ...canvasSchema.properties, blockId: { type: 'string', description: 'Optional document to inspect' },
      crossCanvas: { type: 'boolean', description: 'Include other canvases in this workspace' } },
  }, findDuplicates);
  mcp.registerTool('merge_documents', 'Merge reviewed duplicates into complete replacement content. Requires current content hashes for every affected document.', {
    type: 'object', properties: { ...canvasSchema.properties, keepBlockId: { type: 'string' },
      mergeBlockIds: { type: 'array', items: { type: 'string' } }, content: { type: 'string', description: 'Complete merged source' },
      expectedContentHashes: { type: 'object', additionalProperties: { type: 'string' } } },
    required: ['keepBlockId', 'mergeBlockIds', 'content', 'expectedContentHashes'],
  }, mergeDocuments);
  mcp.registerTool('connect_across_canvases', 'Suggest related documents across canvases in one workspace without saving links.', canvasSchema, connectAcrossCanvases);
  mcp.registerTool('score_documents', 'Score document quality and canvas health without changing saved documents.', canvasSchema, scoreDocuments);
  mcp.registerTool('run_workspace_automation', 'Preview a Jev automation across a workspace by default. To apply, supply dryRun false and selected actionIds from a preview.', {
    type: 'object', properties: { workspaceId: { type: 'string' }, kind: { type: 'string', enum: workspaceKinds },
      dryRun: { type: 'boolean' }, runId: { type: 'string' }, actionIds: { type: 'array', items: { type: 'string' } } },
    required: ['workspaceId', 'kind'],
  }, runWorkspaceAutomation);
  mcp.registerTool('undo_jev_run', 'Undo a workspace Jev run where saved documents still match the applied changes.', {
    type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'],
  }, undoJevRun);
  mcp.registerTool('undo_merge', 'Undo a document merge when the surviving document and affected links still match the saved merge.', {
    type: 'object', properties: { mergeId: { type: 'string' } }, required: ['mergeId'],
  }, undoMerge);
  const groupedSchema: JsonSchema = { type: 'object', properties: { ...canvasSchema.properties,
    groupBy: { type: 'string', enum: ['work_area', 'purpose', 'lane'], description: 'Group by Jev work area (default), purpose, or reading lane' } } };
  mcp.registerTool('organize_canvas', 'Classify documents into groups and place each group on the canvas.', groupedSchema, jevAutomation('layout'));
  mcp.registerTool('regroup_canvas', 'Classify and place document groups, then update useful links.', groupedSchema, jevAutomation('regroup'));
  mcp.registerTool('connect_documents', 'Add Jev-rated document links and remove links Jev rejects.', canvasSchema, jevAutomation('connection'));
  mcp.registerTool('label_purposes', 'Apply high-confidence Jev purpose labels.', canvasSchema, jevAutomation('purpose'));
  mcp.registerTool('classify_work_areas', 'Use Jev to label document work areas from over 100 choices.', canvasSchema, jevAutomation('work_area'));
  mcp.registerTool('assign_reviewers', 'Apply high-confidence Jev reviewer suggestions.', canvasSchema, jevAutomation('reviewer'));
  mcp.registerTool('cross_connect_canvas', 'Apply high-confidence Jev cross-canvas connection suggestions.', canvasSchema, jevAutomation('cross_connect'));

  const docVersionSchema = { canvasId: { type: 'string' }, blockId: { type: 'string' } };
  mcp.registerTool('list_versions', 'List Git branches and revisions for one document file.', {
    type: 'object', properties: docVersionSchema, required: ['blockId'],
  }, async args => textResult(await api(path(canvasIdFrom(args), requiredString(args, 'blockId')) + '/versions')));
  const branchSchema: JsonSchema = { type: 'object', properties: { ...docVersionSchema, name: { type: 'string' } }, required: ['blockId', 'name'] };
  mcp.registerTool('create_branch', 'Create a branch for one document file.', branchSchema, versionOperation('branches', 'name'));
  mcp.registerTool('switch_branch', 'Switch one document file to an existing branch.', branchSchema, versionOperation('switch', 'name'));
  mcp.registerTool('merge_branch', 'Merge one document file from another branch, reporting conflicts.', branchSchema, versionOperation('merge', 'name'));
  mcp.registerTool('restore_revision', 'Restore a revision as a new commit.', {
    type: 'object', properties: { ...docVersionSchema, revision: { type: 'string' } }, required: ['blockId', 'revision'],
  }, versionOperation('restore', 'revision'));

  mcp.registerResource('active_canvas', 'Current canvas layout and Markdown blocks.', {
    uri: 'canvas://active', mimeType: 'application/json',
  }, readActiveCanvas);
}

export function registerWebMCP(getActiveCanvasId: () => string, onChanged: () => void) {
  activeCanvas = getActiveCanvasId;
  changed = onChanged;
  let active = true;
  void loadScript().then(() => {
    if (!active || !window.WebMCP) return;
    if (!instance) {
      instance = new window.WebMCP({ color: '#bce7c9', position: 'bottom-left', size: '28px', padding: '18px' });
      registerTools(instance);
    }
  }).catch(error => {
    if (active) console.warn('WebMCP unavailable:', error);
  });
  return () => { active = false; };
}
