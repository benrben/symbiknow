// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { CanvasStore } from '../server/storage';
import type { CanvasDocument } from '../shared/types';
import { App } from './App';
import { assistantFixture, installAssistantBrowser, jsonBody } from './AppAssistantPanel.test.helpers';
import { ModelBoundary, state } from './canvas-model.test.helpers';

installAssistantBrowser();

function documentCard() {
  const card = document.querySelector('[data-id="roadmap-overview"] .canvas-card');
  if (!card) throw new Error('Missing actual saved document card');
  return within(card as HTMLElement);
}

function nativeDrag(target: Element, dx: number, dy: number) {
  const view = target.ownerDocument.defaultView;
  if (!view) throw new Error('Missing native drag window');
  for (const [type, recipient, x, y, buttons] of [
    ['mousedown', target, 320, 240, 1], ['mousemove', view, 322, 240, 1],
    ['mousemove', view, 322 + dx, 240 + dy, 1], ['mouseup', view, 322 + dx, 240 + dy, 0],
  ] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons });
    // jsdom 29 rejects its VM Window in MouseEventInit.view. Supply that
    // normal public event field for the unchanged installed D3 input handler.
    Object.defineProperty(event, 'view', { value: view });
    fireEvent(recipient, event);
  }
}

function renderedPosition(id: string) {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  const coordinates = node?.style.transform.match(/^translate\(([-\d.]+)px,\s*([-\d.]+)(?:px)?\)/);
  return coordinates ? { x: Number(coordinates[1]), y: Number(coordinates[2]) } : undefined;
}

describe('CanvasView selection lifecycle through the actual App and saved API', () => {
  it('keeps a closed focused inspector closed after a persisted owner PUT/GET refresh and retains the saved document across restart', async () => {
    const fixture = await assistantFixture(undefined, false);
    const original = await fixture.read('product-roadmap');
    const beforeHistory = await new CanvasStore(fixture.root).documentHistory(original.id, 'roadmap-overview');
    fixture.unmount();
    function PersistedOwner() {
      const [canvas, setCanvas] = useState(original);
      const [opened, setOpened] = useState('');
      async function update(id: string, patch: Partial<CanvasDocument['blocks'][number]>) {
        const response = await fixture.request(`/api/canvases/${canvas.id}/blocks/${id}`, { ...jsonBody(patch), method: 'PUT' });
        expect(response.status).toBe(200);
        setCanvas(await fixture.read(canvas.id));
      }
      return <>
        <button onClick={() => { void update('roadmap-overview', { content: '# Refreshed persisted evidence\nOwner refresh after Close' }); }}>Refresh persisted document</button>
        <output aria-label="Opened persisted document">{opened}</output>
        <ModelBoundary canvasProps={{ canvas, focusRequest: { blockId: 'roadmap-overview', sequence: 1 },
          viewportRequest: { x: 33, y: 44, zoom: .9, sequence: 1 }, onUpdateBlock: update,
          onDeleteBlock: async id => {
            expect((await fixture.request(`/api/canvases/${canvas.id}/blocks/${id}`, { method: 'DELETE' })).status).toBe(200);
            setCanvas(await fixture.read(canvas.id));
          }, onSelectBlock: value => { setOpened(value.id); } }} />
      </>;
    }
    render(<ReactFlowProvider><PersistedOwner /></ReactFlowProvider>);
    await screen.findByRole('complementary', { name: 'Selection inspector' });
    expect(state().selected).toEqual(['roadmap-overview']);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(state().selected).toEqual([]);
    expect(document.querySelector('[data-id="roadmap-overview"]')?.classList.contains('selected')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh persisted document' }));
    await waitFor(() => expect(documentCard().getByText('Owner refresh after Close')).toBeTruthy());
    const saved = await fixture.read(original.id);
    expect(saved.blocks.find(value => value.id === 'roadmap-overview')?.content).toBe('# Refreshed persisted evidence\nOwner refresh after Close');
    const restarted = new CanvasStore(fixture.root); await restarted.init();
    expect(await restarted.getCanvas(original.id)).toEqual(saved);
    const history = await restarted.documentHistory(original.id, 'roadmap-overview');
    expect(history.commits.length).toBe(beforeHistory.commits.length + 1);
    expect(history.commits[0].message).toContain('Edit');
    expect(state().selected).toEqual([]);
    expect(screen.queryByRole('complementary', { name: 'Selection inspector' })).toBeNull();
    expect(document.querySelector('[data-id="roadmap-overview"]')?.classList.contains('selected')).toBe(false);
  });

  it('clears the rendered selection on Close, allows a deliberate checkbox reselection and persists its save through reload', async () => {
    const fixture = await assistantFixture(undefined, false, async request => {
      const original = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
      for (const block of original.blocks.filter(value => value.id !== 'roadmap-overview')) {
        expect((await request(`/api/canvases/${original.id}/blocks/${block.id}`, { method: 'DELETE' })).status).toBe(200);
      }
      expect((await request('/api/canvases/product-roadmap/blocks/roadmap-overview', {
        ...jsonBody({ content: '# Saved inspector lifecycle\n- [ ] Review selection', x: 100, y: 200, width: 320, height: 240 }), method: 'PUT',
      })).status).toBe(200);
    });
    await waitFor(() => expect(document.querySelector('[data-id="roadmap-overview"]')).toBeTruthy());
    const node = document.querySelector('[data-id="roadmap-overview"]');
    if (!node) throw new Error('Missing installed document node');
    fireEvent.click(node);
    await screen.findByRole('complementary', { name: 'Selection inspector' });
    expect(node.classList.contains('selected')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Selection inspector' })).toBeNull();
    expect(node.classList.contains('selected')).toBe(false);
    fireEvent.click(await documentCard().findByRole('checkbox'));
    await waitFor(() => expect((documentCard().getByRole('checkbox') as HTMLInputElement).checked).toBe(true));
    const saved = await fixture.read('product-roadmap');
    expect(saved.blocks[0].content).toContain('- [x] Review selection');
    const restarted = new CanvasStore(fixture.root); await restarted.init();
    expect(await restarted.getCanvas(saved.id)).toEqual(saved);
    expect(screen.getByRole('complementary', { name: 'Selection inspector' })).toBeTruthy();
    expect(document.querySelector('[data-id="roadmap-overview"]')?.classList.contains('selected')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Selection inspector' })).toBeNull();
    expect(document.querySelector('[data-id="roadmap-overview"]')?.classList.contains('selected')).toBe(false);
    fixture.unmount(); render(<App/>);
    await screen.findByText(saved.name, { selector: '.canvas-label h1' });
    await waitFor(() => expect((documentCard().getByRole('checkbox') as HTMLInputElement).checked).toBe(true));
    expect(screen.queryByRole('complementary', { name: 'Selection inspector' })).toBeNull();
    const restored = document.querySelector('[data-id="roadmap-overview"]');
    if (!restored) throw new Error('Missing reloaded saved document');
    fireEvent.click(restored);
    await screen.findByRole('complementary', { name: 'Selection inspector' });
    fireEvent.click(await documentCard().findByRole('checkbox'));
    await waitFor(() => expect((documentCard().getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    expect(screen.getByRole('complementary', { name: 'Selection inspector' })).toBeTruthy();
    const unchecked = await fixture.read(saved.id);
    expect(unchecked.blocks[0].content).toContain('- [ ] Review selection');
    expect(await restarted.getCanvas(saved.id)).toEqual(unchecked);
  });

  it('persists native document and group drags through the installed D3 renderer and restores both saved positions', async () => {
    const fixture = await assistantFixture(undefined, false, async request => {
      const original = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
      for (const [index, value] of original.blocks.entries()) {
        if (index > 1) {
          expect((await request(`/api/canvases/${original.id}/blocks/${value.id}`, { method: 'DELETE' })).status).toBe(200);
        } else {
          expect((await request(`/api/canvases/${original.id}/blocks/${value.id}`, {
            ...jsonBody({ x: 100 + index * 400, y: 200, width: 320, height: 240, group: 'lane:overview', links: [] }), method: 'PUT',
          })).status).toBe(200);
        }
      }
    });
    const original = await fixture.read('product-roadmap');
    await waitFor(() => expect(document.querySelector(`[data-id="${original.blocks[0].id}"] .canvas-card__grip`)).toBeTruthy());
    const grip = document.querySelector(`[data-id="${original.blocks[0].id}"] .canvas-card__grip`);
    if (!grip) throw new Error('Missing native document drag grip');
    nativeDrag(grip, 80, 20);
    await waitFor(async () => expect((await fixture.read(original.id)).blocks.map(value => [value.x, value.y])).toEqual([[180, 220], [500, 200]]));
    await waitFor(() => expect(renderedPosition(original.blocks[0].id)).toEqual({ x: 180, y: 220 }));
    const heading = document.querySelector('[data-id="group:lane:overview"] .canvas-group__heading');
    if (!heading) throw new Error('Missing native group drag heading');
    nativeDrag(heading, 60, 40);
    await waitFor(async () => expect((await fixture.read(original.id)).blocks.map(value => [value.x, value.y])).toEqual([[240, 260], [560, 240]]));
    const saved = await fixture.read(original.id);
    const restarted = new CanvasStore(fixture.root); await restarted.init();
    expect(await restarted.getCanvas(saved.id)).toEqual(saved);
    fixture.unmount(); render(<App/>);
    await screen.findByText(saved.name, { selector: '.canvas-label h1' });
    await waitFor(() => expect(renderedPosition(saved.blocks[0].id)).toEqual({ x: 240, y: 260 }));
    expect(renderedPosition(saved.blocks[1].id)).toEqual({ x: 560, y: 240 });
  });
});
