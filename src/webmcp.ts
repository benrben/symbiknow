import { api } from './api';
import { canvasIdFrom, path, requiredString, textResult } from './webmcp-arguments';
import { registerContext } from './webmcp-context';
import { loadScript } from './webmcp-loader';
import { createDoc, downloadFile, editDoc, moveBlock, moveDocument, openDoc, removeDoc, uploadFile } from './webmcp-documents';
import { readActiveCanvas, searchDocs } from './webmcp-queries';
import { versionOperation } from './webmcp-versions';
import type { JsonSchema, WebMCPInstance } from './webmcp-types';

let instance: WebMCPInstance | null = null;

function registerTools(mcp: WebMCPInstance) {
  mcp.registerTool('search_docs', 'Search Markdown documents in all workspaces.', {
    type: 'object', properties: { query: { type: 'string', description: 'Text to search for' } }, required: ['query'],
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
  const releaseContext = registerContext(getActiveCanvasId, onChanged);
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
  return () => { active = false; releaseContext(); };
}
