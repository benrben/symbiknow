// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatViewContext } from '../shared/answer-canvas';
import type { CanvasDocument } from '../shared/types';
import { CanvasStore } from '../server/storage';
import { AssistantPanel } from './AppAssistantPanel';
import { assistantFixture, installAssistantBrowser, jsonBody, turn } from './AppAssistantPanel.test.helpers';
import { useAppModel } from './app-model';
import { useAssistantContext } from './app-assistant-context';
import { MainColumn, Sidebar } from './AppWorkspaceView';
import { cameraFrames, nativeCameraClock } from './CanvasOverview.readiness.test.helpers';
import type { CanvasViewport } from './useCanvasJourney';
import { block, canvas, instance, mount, props } from './canvas-model.test.helpers';
import type { CanvasProps } from './canvas-types';

installAssistantBrowser();

// Observe the actual model contract while its normal workspace and research
// components retain every production handler and the installed renderer.
function NativeContextWorkspace({ observations }: { observations: ChatViewContext[] }) {
  const model = useAppModel();
  const context = useAssistantContext(model);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => { observations.push(context); }, [context, observations]);
  return <>
    <Sidebar model={model}/>
    <MainColumn model={model} theme={theme} onToggleTheme={() => setTheme(current => current === 'light' ? 'dark' : 'light')}/>
    <AssistantPanel model={model}/>
    <output aria-label="Native current view">{JSON.stringify(context)}</output>
  </>;
}

function context(): ChatViewContext {
  return JSON.parse(screen.getByLabelText('Native current view').textContent ?? '{}') as ChatViewContext;
}

function camera(surface: Element | Document = document): CanvasViewport {
  const transform = surface.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? '';
  const matched = /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(transform);
  if (!matched) throw new Error('Missing native camera: ' + transform);
  return { x: Number(matched[1]), y: Number(matched[2]), zoom: Number(matched[3]) };
}

function startNativeClock() {
  const time = performance.now(), epoch = Date.now();
  nativeCameraClock();
  vi.spyOn(performance, 'now').mockImplementation(() => time + Date.now() - epoch);
}

describe('native workspace and research viewport consumers', () => {
  it('settles saved and research view context across native zoom bands and stops publishing after unmount', async () => {
    const fixture = await assistantFixture(undefined, true, async request => {
      const saved = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
      for (const block of saved.blocks.slice(2)) {
        expect((await request('/api/canvases/' + saved.id + '/blocks/' + block.id, { method: 'DELETE' })).status).toBe(200);
      }
      for (const [index, block] of saved.blocks.slice(0, 2).entries()) {
        expect((await request('/api/canvases/' + saved.id + '/blocks/' + block.id,
          { ...jsonBody({ x: 100 + index * 400, y: 200, width: 320, height: 240, group: index ? 'custom:beta' : 'custom:alpha' }), method: 'PUT' })).status).toBe(200);
      }
    });
    const saved = await fixture.read('product-roadmap');
    const history = await new CanvasStore(fixture.root).documentHistory(saved.id, saved.blocks[0].id);
    fixture.unmount();
    const observations: ChatViewContext[] = [];
    const owner = render(<NativeContextWorkspace observations={observations}/>);
    await screen.findByText(saved.name, { selector: '.canvas-label h1' });
    await waitFor(() => {
      const nodes = owner.container.querySelectorAll<HTMLElement>('.react-flow__node-document');
      expect(nodes).toHaveLength(saved.blocks.length);
      for (const node of nodes) expect(node.style.visibility).not.toBe('hidden');
    });
    // Finish the already scheduled normal-clock debounce before taking native
    // platform clock ownership; no pending timer is migrated to a new clock.
    await waitFor(() => expect(context().viewport).toEqual(camera()));
    startNativeClock();
    // Camera transitions finish within 350 ms; consumers debounce for 180 ms.
    await cameraFrames(600);
    expect(camera().zoom).toBe(1);
    expect(context()).toMatchObject({ viewMode: 'documents', visibleBlockIds: saved.blocks.map(block => block.id) });
    for (let index = 0; index < 3; index++) fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }));
    await cameraFrames(600);
    expect(camera().zoom).toBeGreaterThanOrEqual(.34);
    expect(camera().zoom).toBeLessThan(.75);
    expect(context()).toMatchObject({ viewMode: 'titles', visibleBlockIds: saved.blocks.map(block => block.id), visibleGroups: ['custom:alpha', 'custom:beta'], viewport: camera() });

    fireEvent.click(screen.getByRole('button', { name: 'Open research canvas' }));
    const research = screen.getByRole('region', { name: 'Research canvas' });
    await cameraFrames(600);
    expect(context()).toMatchObject({ viewMode: 'answer', visibleBlockIds: [], answerFocus: {
      visibleQuestions: [turn.query], visibleBlockTitles: ['Release review'], visibleSourceIds: [],
    } });
    for (let index = 0; index < 5; index++) fireEvent.click(within(research).getByRole('button', { name: 'Zoom In' }));
    await cameraFrames(600);
    expect(camera(research).zoom).toBeGreaterThanOrEqual(.9);
    expect(context().answerFocus).toMatchObject({ level: 'sources', visibleQuestions: [turn.query], visibleBlockTitles: ['Release review'] });
    for (let index = 0; index < 7; index++) fireEvent.click(within(research).getByRole('button', { name: 'Zoom Out' }));
    await cameraFrames(600);
    expect(camera(research).zoom).toBeGreaterThanOrEqual(.45);
    expect(camera(research).zoom).toBeLessThan(.9);
    expect(context().answerFocus).toMatchObject({ level: 'answers', visibleQuestions: [turn.query], visibleBlockTitles: ['Release review'] });
    for (let index = 0; index < 3; index++) fireEvent.click(within(research).getByRole('button', { name: 'Zoom Out' }));
    await cameraFrames(600);
    expect(camera(research).zoom).toBeLessThan(.45);
    expect(context().answerFocus?.level).toBe('big-picture');
    expect(context().answerFocus?.visibleSourceIds).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Return to main canvas' }));
    await cameraFrames(600);
    expect(context()).toMatchObject({ viewMode: 'titles', visibleBlockIds: saved.blocks.map(block => block.id), visibleGroups: ['custom:alpha', 'custom:beta'] });
    expect(context().answerFocus).toBeUndefined();
    owner.unmount();
    const count = observations.length;
    await cameraFrames(200);
    expect(observations).toHaveLength(count);
    expect(await fixture.read(saved.id)).toEqual(saved);
    const restarted = new CanvasStore(fixture.root); await restarted.init();
    expect(await restarted.getCanvas(saved.id)).toEqual(saved);
    expect(await restarted.documentHistory(saved.id, saved.blocks[0].id)).toEqual(history);
  });

  it('publishes committed node and group snapshots through current callbacks across native canvas ABA and cancels detached end reports', async () => {
    startNativeClock();
    const first = canvas([block('a', { x: 100, group: 'custom:alpha' }), block('b', { x: 500, group: 'custom:beta' })], 'first');
    const second = canvas([block('c', { x: 100, group: 'custom:gamma' })], 'second');
    type Report = Parameters<NonNullable<CanvasProps['onViewportChange']>>;
    const initialReports: Report[] = [], latestReports: Report[] = [];
    const initial = { ...props(first), onViewportChange: (...report: Report) => { initialReports.push(report); } };
    const latest = { ...initial, onViewportChange: (...report: Report) => { latestReports.push(report); } };
    const owner = mount({ canvasProps: { ...initial, viewportRequest: { x: 0, y: 0, zoom: 1, sequence: 1 } } });
    await cameraFrames(600);
    await act(async () => { await instance().setViewport({ x: -500, y: 0, zoom: 1 }, { duration: 0 }); });
    expect(initialReports.at(-1)).toEqual([{ x: -500, y: 0, zoom: 1 }, ['b'], expect.objectContaining({ level: 'documents', visibleGroups: ['custom:beta'] })]);
    owner.change({ canvasProps: { ...latest, canvas: second, viewportRequest: { x: 0, y: 0, zoom: 1, sequence: 2 } } });
    await cameraFrames(600);
    expect(latestReports.at(-1)).toEqual([{ x: 0, y: 0, zoom: 1 }, ['c'], expect.objectContaining({ level: 'documents', visibleGroups: ['custom:gamma'] })]);
    const oldCount = initialReports.length;
    const returned = { ...first, blocks: first.blocks.map(value => value.id === 'b' ? { ...value, group: 'custom:renamed' } : value) };
    owner.change({ canvasProps: { ...latest, canvas: returned, viewportRequest: { x: -500, y: 0, zoom: 1, sequence: 3 } } });
    await cameraFrames(600);
    expect(latestReports.at(-1)).toEqual([{ x: -500, y: 0, zoom: 1 }, ['b'], expect.objectContaining({ level: 'documents', visibleGroups: ['custom:renamed'] })]);
    expect(initialReports).toHaveLength(oldCount);
    await act(async () => { await instance().setViewport({ x: -503, y: 0, zoom: 1 }, { duration: 0 }); });
    const count = latestReports.length;
    owner.unmount();
    await cameraFrames(200);
    expect(latestReports).toHaveLength(count);
  });
});
