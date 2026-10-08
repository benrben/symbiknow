// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CanvasStore } from '../server/storage';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { App } from './App';
import { assistantFixture, jsonBody } from './AppAssistantPanel.test.helpers';
import { installWorkspaceBrowser } from './AppWorkspaceView.test.helpers';
import { resizeHandle } from './CanvasNodes.test.helpers';
import type { VersionStatus } from './version-panel-types';

installWorkspaceBrowser();
async function sourceCard(title: string) {
  const button = await screen.findByRole('button', { name: `Edit ${title}` });
  const node = button.closest<HTMLElement>('.canvas-card');
  if (!node) throw new Error('Missing saved document node');
  return node;
}
async function completedRead<T>(pending: Promise<Response>) {
  let result!: T;
  await act(async () => {
    const response = await pending;
    expect(response.ok).toBe(true);
    result = await response.json() as T;
  });
  return result;
}

describe('saved document node boundaries through native App and API', () => {
  it('contains a failed checkbox write, retries through HTTP, resizes from native input and restores the persisted dimensions/content/history', async () => {
    let fail = true;
    const writes: unknown[] = [];
    const fixture = await assistantFixture(async (route, init, forward) => {
      if (route.endsWith('/blocks/roadmap-overview') && init.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        if (fail) { fail = false; return Response.json({ error: 'Node save temporarily unavailable' }, { status: 503 }); }
      }
      return forward();
    }, false, async request => {
      const initial = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
      for (const block of initial.blocks.filter(value => value.id !== 'roadmap-overview')) {
        expect((await request(`/api/canvases/${initial.id}/blocks/${block.id}`, { method: 'DELETE' })).status).toBe(200);
      }
      expect((await request('/api/canvases/product-roadmap/blocks/roadmap-overview', {
        ...jsonBody({ title: 'Persisted node evidence', content: '# Evidence\n- [ ] Review accepted', width: 320, height: 240, x: 100, y: 200 }), method: 'PUT',
      })).status).toBe(200);
    });
    const initial = await fixture.read('product-roadmap');
    const node = await sourceCard('Persisted node evidence');
    const checkbox = await within(node).findByRole('checkbox');
    fireEvent.click(checkbox);
    await waitFor(() => expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('Node save temporarily unavailable'))).toBe(true));
    expect(await fixture.read(initial.id)).toEqual(initial);
    expect((within(node).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(node).getByRole('checkbox'));
    await waitFor(async () => expect((await fixture.read(initial.id)).blocks[0].content).toContain('- [x] Review accepted'));
    const wrapper = node.closest<HTMLElement>('.react-flow__node');
    if (!wrapper) throw new Error('Missing installed node wrapper');
    fireEvent.click(wrapper);
    await waitFor(() => expect(node.querySelector('.react-flow__resize-control.bottom.right.handle')).toBeTruthy());
    const handle = node.querySelector('.react-flow__resize-control.bottom.right.handle');
    if (!handle) throw new Error('Missing installed resize input');
    const style = document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? '';
    const zoom = Number(/scale\(([^)]+)\)/.exec(style)?.[1]);
    expect(zoom).toBeGreaterThan(0);
    resizeHandle(handle, 120, 70);
    // The resize save goes through HTTP and a Git commit; allow for a loaded coverage run, not the 1 s default.
    await waitFor(async () => expect((await fixture.read(initial.id)).blocks[0].width).toBeGreaterThan(320), { timeout: 5_000 });
    const saved = await fixture.read(initial.id);
    expect(saved.blocks[0]).toMatchObject({ x: 100, y: 200 });
    expect(saved.blocks[0].width).toBeCloseTo(Math.round(320 + 120 / zoom), 0);
    expect(saved.blocks[0].height).toBeCloseTo(Math.round(240 + 70 / zoom), 0);
    expect(writes).toHaveLength(3);
    expect(await readFile(path.join(fixture.root, saved.blocks[0].file), 'utf8')).toContain('- [x] Review accepted');
    const restarted = new CanvasStore(fixture.root);
    await restarted.init();
    expect(await restarted.getCanvas(saved.id)).toEqual(saved);
    expect((await restarted.documentHistory(saved.id, saved.blocks[0].id)).commits.length).toBeGreaterThan(2);
    fixture.unmount();
    render(<App/>);
    const restored = await sourceCard('Persisted node evidence');
    await waitFor(() => expect(restored.closest('.react-flow__node')?.getAttribute('style')).toContain(`width: ${saved.blocks[0].width}px`));
    expect((await within(restored).findByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(await fixture.read(saved.id)).toEqual(saved);
  });
  it('renders persisted metadata and navigates read/history/edit and cross-canvas portal controls without changing saved documents', async () => {
    let destination!: CanvasDocument;
    let target!: CanvasBlock;
    const reads = new Map<string, (response: Response) => void>();
    function nextRead(route: string) { return new Promise<Response>(resolve => { reads.set(route, resolve); }); }
    const fixture = await assistantFixture(async (route, init, forward) => {
      const arrived = (init.method ?? 'GET') === 'GET' ? reads.get(route) : undefined;
      if (arrived) reads.delete(route);
      const response = await forward();
      arrived?.(response.clone());
      return response;
    }, false, async request => {
      const source = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
      const created = await request(`/api/workspaces/${source.workspaceId}/canvases`, jsonBody({ name: 'Related release evidence' }));
      expect(created.status).toBe(201);
      destination = await created.json() as CanvasDocument;
      const document = await request(`/api/canvases/${destination.id}/blocks`, jsonBody({ title: 'Related release proof', content: '# Remote linked evidence' }));
      expect(document.status).toBe(201);
      target = await document.json() as CanvasBlock;
      const unrelated = await request(`/api/canvases/${destination.id}/blocks`, jsonBody({ title: 'Unrelated overview', content: '# Unrelated' }));
      expect(unrelated.status).toBe(201);
      const moved = await request(`/api/canvases/${destination.id}/blocks/${target.id}`, {
        ...jsonBody({ x: 4200, y: 1900 }), method: 'PUT',
      });
      expect(moved.status).toBe(200);
      target = await moved.json() as CanvasBlock;
      const changed = await request('/api/canvases/product-roadmap/blocks/roadmap-overview', {
        ...jsonBody({ purpose: 'decision', workArea: 'design_systems', reviewer: 'Ada', tags: ['release', 'staged', 'review', 'shipping'],
          crossLinks: [{ canvasId: destination.id, blockId: target.id, relation: 'same_topic' }] }), method: 'PUT',
      });
      expect(await changed.json()).not.toHaveProperty('error');
      expect(changed.status).toBe(200);
    });
    const original = await fixture.read('product-roadmap');
    const source = original.blocks.find(block => block.id === 'roadmap-overview');
    if (!source) throw new Error('Missing source document');
    const title = source.title;
    const node = await sourceCard(title);
    expect(within(node).getByTitle('Purpose: decision')).toBeTruthy();
    expect(within(node).getByTitle('Work area: design systems')).toBeTruthy();
    expect(within(node).getByTitle('Reviewer: Ada')).toBeTruthy();
    const labels = within(node).getByLabelText(`Labels for ${title}`);
    expect(labels.textContent).toBe('releasestagedreview+1');
    expect(labels.getAttribute('title')).toBe('release, staged, review, shipping');
    const sourcePath = '/api/canvases/product-roadmap/blocks/roadmap-overview';
    const sourceRead = nextRead(sourcePath);
    fireEvent.click(within(node).getByRole('button', { name: `Read ${title} full page` }));
    expect(await completedRead<CanvasBlock>(sourceRead)).toMatchObject({ id: source.id, content: source.content });
    const reader = await screen.findByRole('dialog', { name: `${title} full page` });
    await within(reader).findByRole('heading', { name: source.content.split('\n')[0].replace(/^#\s*/, ''), level: 1 });
    fireEvent.click(within(reader).getByRole('button', { name: '← Back to canvas' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `${title} full page` })).toBeNull());
    const historyResponse = nextRead(sourcePath + '/versions');
    fireEvent.click(within(await sourceCard(title)).getByRole('button', { name: `History for ${title}` }));
    const history = await screen.findByRole('dialog', { name: 'History and branches' });
    expect((await completedRead<VersionStatus>(historyResponse)).commits.length).toBeGreaterThan(0);
    expect((await within(history).findAllByRole('button', { name: 'Inspect revision' })).length).toBeGreaterThan(0);
    fireEvent.click(within(history).getByRole('button', { name: 'Close dialog' }));
    const editorRead = nextRead(sourcePath);
    fireEvent.click(within(await sourceCard(title)).getByRole('button', { name: `Edit ${title}` }));
    expect(await completedRead<CanvasBlock>(editorRead)).toMatchObject({ id: source.id, content: source.content });
    const editor = await screen.findByRole('dialog', { name: 'Document editor' });
    expect((within(editor).getByRole('textbox', { name: /^Title$/ }) as HTMLInputElement).value).toBe(title);
    fireEvent.click(within(editor).getByRole('button', { name: 'Close dialog' }));
    const destinationRead = nextRead('/api/canvases/' + destination.id);
    const targetRead = nextRead(`/api/canvases/${destination.id}/blocks/${target.id}`);
    fireEvent.click(within(await sourceCard(title)).getByRole('button', { name: `Open related document ${target.id} on canvas ${destination.id}` }));
    expect(await completedRead<CanvasDocument>(destinationRead)).toMatchObject({ id: destination.id, name: destination.name });
    expect(await completedRead<CanvasBlock>(targetRead)).toMatchObject({ id: target.id, content: target.content });
    await screen.findByText(destination.name, { selector: '.canvas-label h1' });
    const related = await screen.findByRole('dialog', { name: `${target.title} full page` });
    expect(within(related).getByRole('heading', { name: 'Related release proof', level: 1 })).toBeTruthy();
    expect(await within(related).findByRole('heading', { name: 'Remote linked evidence' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(`.react-flow__node[data-id="${target.id}"]`)?.classList.contains('selected')).toBe(true));
    expect(document.querySelector('.react-flow__node[data-id="unrelated-overview"]')?.classList.contains('selected')).not.toBe(true);
    await waitFor(() => {
      const viewport = document.querySelector('.react-flow__viewport') as HTMLElement | null;
      const transform = /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(viewport?.style.transform ?? '');
      expect(transform).not.toBeNull();
      const focusedX = Number(transform![1]) + (target.x + target.width / 2) * Number(transform![3]);
      expect(focusedX).toBeGreaterThan(400);
      expect(focusedX).toBeLessThan(600);
    });
    expect(new URL(window.location.href).searchParams.get('doc')).toBe(target.id);
    expect(await fixture.read(original.id)).toEqual(original);
    const restarted = new CanvasStore(fixture.root);
    await restarted.init();
    expect(await restarted.getCanvas(original.id)).toEqual(original);
  });
});
