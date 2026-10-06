// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { clearLegacyTasksView, locationFor } from './app-model-helpers';

beforeEach(() => window.history.replaceState(null, '', '/workspace?canvas=old&doc=old-doc&view=tasks&filter=mine#section'));

it('keeps unrelated URL context while switching between canvas and reader addresses', () => {
  expect(locationFor('planning')).toBe('/workspace?canvas=planning&filter=mine#section');
  expect(locationFor('planning', 'source')).toBe('/workspace?canvas=planning&doc=source&filter=mine#section');
  expect(locationFor('')).toBe('/workspace?filter=mine#section');
});

it('replaces a retired Tasks view URL while keeping canvas, filters, hash, and history state', () => {
  const state = { from: 'history' };
  window.history.replaceState(state, '', '/workspace?canvas=planning&view=tasks&filter=mine#section');
  clearLegacyTasksView();
  expect(window.location.pathname + window.location.search + window.location.hash)
    .toBe('/workspace?canvas=planning&filter=mine#section');
  expect(window.history.state).toEqual(state);
  clearLegacyTasksView();
  expect(window.history.state).toEqual(state);
});

it('removes the question mark when the retired view is the only query parameter', () => {
  window.history.replaceState({ from: 'legacy-link' }, '', '/workspace?view=tasks#section');
  clearLegacyTasksView();
  expect(window.location.pathname + window.location.search + window.location.hash).toBe('/workspace#section');
  expect(window.history.state).toEqual({ from: 'legacy-link' });
});
