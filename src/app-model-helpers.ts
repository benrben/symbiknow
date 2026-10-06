import { uploadedSource } from '../shared/file-transfer';
import type { BlockKind, CanvasBlock } from '../shared/types';

export type Dialog = 'block' | 'workspace' | 'canvas' | 'delete-canvas' | 'delete-workspace' | 'settings' | 'versions' | null;
export type BlockDraft = Pick<CanvasBlock, 'title' | 'kind' | 'content'> & { id?: string; contentHash?: string };

export const starterContent: Record<BlockKind, string> = {
  markdown: '# Untitled note\n\nStart writing here.\n',
  slides: '# New presentation\n\nYour opening slide.\n\n---\n\n# Next slide\n',
  website: '---\ngenerator: mkdocs\nsource: ./site\n---\n\n# Website preview\n',
  mdx: '# Interactive document\n\nWrite MDX here.\n',
};
export const initialDraft: BlockDraft = { title: '', kind: 'markdown', content: '' };

export function updatedBlockDraft(current: BlockDraft, kind: BlockKind): BlockDraft {
  const keepContent = Boolean(current.id) || current.content !== starterContent[current.kind];
  return { ...current, kind, content: keepContent ? current.content : starterContent[kind] };
}

export function renamedBlockDraft(current: BlockDraft, title: string): BlockDraft {
  const heading = `# ${current.title}\n`;
  const content = !current.id && current.kind === 'markdown' && current.content.startsWith(heading)
    ? `# ${title}\n${current.content.slice(heading.length)}` : current.content;
  return { ...current, title, content };
}

/** Keep canvas and reader addresses linkable and compatible with browser Back. */
export function locationFor(canvasId: string, docId = ''): string {
  const params = new URLSearchParams(window.location.search);
  setLocationParam(params, 'canvas', canvasId);
  setLocationParam(params, 'doc', docId);
  params.delete('view');
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
}

export function clearLegacyTasksView(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('view') !== 'tasks') return;
  params.delete('view');
  const query = params.toString();
  window.history.replaceState(window.history.state, '',
    `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

function setLocationParam(params: URLSearchParams, name: string, value: string) {
  if (value) params.set(name, value);
  else params.delete(name);
}

export function urlParam(name: 'canvas' | 'doc'): string {
  return new URLSearchParams(window.location.search).get(name) ?? '';
}

export async function importedFile(file: File): Promise<{ kind: BlockKind; content: string }> {
  const content = await file.text();
  return uploadedSource(file.name, content);
}

export function blockPath(canvasId: string, blockId: string) {
  return '/canvases/' + encodeURIComponent(canvasId) + '/blocks/' + encodeURIComponent(blockId);
}
