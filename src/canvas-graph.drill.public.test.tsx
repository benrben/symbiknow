// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { block, camera, canvas, installCanvasBrowser, instance, mount, props, resize, run, state } from './canvas-model.test.helpers';
import { visibleLinkCounts } from './canvas-flow-nodes';

installCanvasBrowser();

it('counts links to documents outside the visible group without losing internal links', () => {
  const source = block('source', { links: ['inside', 'outside', 'ungrouped', 'missing'] });
  const inside = block('inside');
  const outside = block('outside', { links: ['source'] });
  const ungrouped = block('ungrouped');
  const groupFor = (value: typeof source) => value.id === 'outside' ? 'custom:other'
    : value.id === 'ungrouped' ? undefined : 'custom:visible';
  const counts = visibleLinkCounts([source, inside, outside, ungrouped], groupFor);
  expect(counts.internal.get('custom:visible')).toBe(1);
  expect(counts.external.get('custom:visible')).toBe(3);
  expect(counts.external.get('custom:other')).toBe(2);
});

it('keeps linked destinations visible and readable when a zoomed group hides their nodes', async () => {
  const source = block('source', { group: 'custom:source', links: ['target'], linkTypes: { target: 'prerequisite' } });
  const target = block('target', { group: 'custom:target', x: 2400, y: 800 });
  const current = props(canvas([source, target]));
  const view = mount({ canvasProps: current, action: model => model.focusGroup('custom:source') });
  run();
  fireEvent.click(await screen.findByRole('group', { name: 'Document: Document source' }));
  const sourceCard = await screen.findByRole('navigation', { name: 'Relationships for Document source' });
  await waitFor(() => expect(document.querySelectorAll('.canvas-card')).toHaveLength(1));
  expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(0);
  expect(sourceCard.previousElementSibling?.classList.contains('canvas-card__header')).toBe(true);
  const outgoing = within(sourceCard).getByRole('button', { name: 'Open linked document Document target' });
  expect(outgoing.title).toBe('Links to Document target · prerequisite');
  fireEvent.click(outgoing);
  expect(current.onSelectBlock).toHaveBeenCalledWith(target);
  await camera({ x: 24, y: 68, zoom: .6 });
  view.change({ canvasProps: { ...current, viewportRequest: { x: 24, y: 68, zoom: .6, sequence: 1 } } });
  await waitFor(() => expect(document.querySelector('.canvas-surface--titles')).toBeTruthy());
  expect(within(sourceCard).getByRole('button', { name: 'Open linked document Document target' })).toBeTruthy();
  expect(current.onUpdateBlock).not.toHaveBeenCalled();
});

it('opens full documents at the fitted zoom of a three-card group in a 696 pixel canvas', async () => {
  resize(696);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(696);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(774);
  const documents = ['release', 'review', 'launch'].map((id, index) => block(id, {
    group: 'custom:release-journal', x: index * 420, y: 0, width: 360, height: 260,
  }));
  const current = props(canvas([...documents, block('other', { group: 'custom:other', x: 4000, y: 3000 })]));
  const view = mount({ canvasProps: current });
  await camera({ x: 24, y: 68, zoom: .51 });
  expect(document.querySelector('.canvas-surface--titles')).toBeTruthy();
  expect(document.querySelectorAll('.canvas-card__body')).toHaveLength(0);

  const navigation = screen.getByRole('navigation', { name: 'Mini-map groups' });
  fireEvent.click(within(navigation).getByText(/^Map ·/));
  fireEvent.click(within(navigation).getByRole('button', { name: /^Release journal/ }));
  await waitFor(() => expect(instance().getZoom()).toBeCloseTo(696 / (1256 + 96), 7));
  expect(state()).toMatchObject({ group: 'custom:release-journal', pinned: false, selected: [] });
  expect(document.querySelector('.canvas-surface--full')).toBeTruthy();
  expect(document.querySelectorAll('.canvas-card')).toHaveLength(3);
  for (const id of ['release', 'review', 'launch']) {
    await screen.findByText('Evidence ' + id, { selector: '.canvas-card__body h1' });
  }
  await camera({ x: 12, y: 24, zoom: instance().getZoom() });
  expect(document.querySelector('.canvas-surface--full')).toBeTruthy();
  expect(document.querySelectorAll('.canvas-card__body')).toHaveLength(3);
  await camera({ x: 24, y: 68, zoom: .6 });
  expect(state().group).toBe('custom:release-journal');
  expect(document.querySelector('.canvas-surface--titles')).toBeTruthy();
  expect(document.querySelectorAll('.canvas-card__body')).toHaveLength(0);
  fireEvent.click(within(navigation).getByRole('button', { name: /^Release journal/ }));
  await waitFor(() => expect(instance().getZoom()).toBeCloseTo(696 / (1256 + 96), 7));
  expect(document.querySelector('.canvas-surface--full')).toBeTruthy();
  view.change({ canvasProps: { ...current, viewportRequest: { x: 24, y: 68, zoom: instance().getZoom(), sequence: 1 } } });
  await waitFor(() => expect(document.querySelector('.canvas-surface--titles')).toBeTruthy());
  expect(document.querySelectorAll('.canvas-card__body')).toHaveLength(0);
  fireEvent.click(within(navigation).getByRole('button', { name: /^Release journal/ }));
  await waitFor(() => expect(document.querySelector('.canvas-surface--full')).toBeTruthy());
  for (const id of ['release', 'review', 'launch']) {
    fireEvent.click(screen.getByRole('button', { name: `Read Document ${id} full page` }));
  }
  expect(vi.mocked(current.onSelectBlock).mock.calls.map(([selected]) => selected.id)).toEqual(['release', 'review', 'launch']);
  expect(current.onUpdateBlock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Return to canvas group overview' }));
  await waitFor(() => expect(instance().getZoom()).toBe(.28));
  expect(state()).toMatchObject({ group: '', pinned: true });
  expect(document.querySelector('.canvas-surface--overview')).toBeTruthy();
  expect(document.querySelectorAll('.canvas-card')).toHaveLength(0);
});

it('gives a newer fitted group ownership at a different target zoom without changing its saved positions', async () => {
  resize(696);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(696);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(774);
  const documents = ['release', 'review', 'launch'].map((id, index) => block(id, {
    group: 'custom:release-journal', x: index * 420, y: 0, width: 360, height: 260,
  }));
  const wide = ['wide-a', 'wide-b', 'wide-c'].map((id, index) => block(id, {
    group: 'custom:wide-reading', x: 4000 + index * 1000, y: 3000, width: 360, height: 260,
  }));
  const current = props(canvas([...documents, ...wide]));
  const originalPositions = current.canvas.blocks.map(({ id, x, y }) => ({ id, x, y }));
  const view = mount({ canvasProps: current, action: model => model.focusGroup('custom:release-journal') });
  await waitFor(() => expect(instance()).toBeTruthy());
  run();
  // Supersede the first requested group before its asynchronous fitted camera applies.
  view.change({ canvasProps: current, action: model => model.focusGroup('custom:wide-reading') });
  run();
  await waitFor(() => expect(instance().getZoom()).toBeCloseTo(.4, 7));
  expect(state()).toMatchObject({ group: 'custom:wide-reading', pinned: false });
  expect(document.querySelector('.canvas-surface--full')).toBeTruthy();
  expect(document.querySelectorAll('.canvas-card__body').length).toBeGreaterThan(0);
  view.change({ canvasProps: current, action: model => model.focusGroup('custom:release-journal') });
  run();
  await waitFor(() => expect(instance().getZoom()).toBeCloseTo(696 / (1256 + 96), 7));
  expect(state().group).toBe('custom:release-journal');
  expect(document.querySelector('.canvas-surface--full')).toBeTruthy();
  expect(current.canvas.blocks.map(({ id, x, y }) => ({ id, x, y }))).toEqual(originalPositions);
  expect(current.onUpdateBlock).not.toHaveBeenCalled();
});

it('opens 100 documents as a bounded overview and keeps Ungrouped files outside a saved hierarchy', async () => {
  const ungrouped = Array.from({ length: 98 }, (_, index) => block(`ungrouped-${index}`, {
    x: 1200 + (index % 14) * 420, y: Math.floor(index / 14) * 340,
  }));
  const current = props(canvas([block('direct', { group: 'custom:launch' }),
    block('review', { group: 'custom:launch/reviews', x: 420 }), ...ungrouped]));
  mount({ canvasProps: current });
  expect(current.canvas.blocks).toHaveLength(100);
  await waitFor(() => expect(document.querySelector('.canvas-surface--overview')).toBeTruthy());
  expect(state().nodes.map(node => node.id).sort()).toEqual(['group:__ungrouped', 'group:custom:launch']);
  expect(document.querySelectorAll('.canvas-card__body')).toHaveLength(0);
  expect(document.querySelectorAll('.react-flow__node-document')).toHaveLength(0);
  const navigation = screen.getByRole('navigation', { name: 'Mini-map groups' });
  fireEvent.click(within(navigation).getByText(/^Map ·/));
  fireEvent.click(within(navigation).getByRole('button', { name: /^Launch/ }));
  await waitFor(() => expect(state()).toMatchObject({ parent: 'custom:launch', group: '', pinned: true }));
  expect(state().nodes.map(node => node.id).sort()).toEqual(['group:custom:launch/reviews', 'group:files:custom:launch']);
  const filesGroup = await screen.findByRole('button', { name: 'Files in this group' });
  expect(filesGroup.parentElement?.querySelector('small')?.textContent).toBe('1 doc');
  expect(current.canvas.blocks.find(block => block.id === 'ungrouped-0')?.group).toBeUndefined();
  expect(current.onUpdateBlock).not.toHaveBeenCalled();
});
