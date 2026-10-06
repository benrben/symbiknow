// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { locationFor } from './app-model-helpers';

beforeEach(() => window.history.replaceState(null, '', '/workspace?canvas=old&doc=old-doc&view=tasks&filter=mine#section'));

it('keeps unrelated URL context while switching between canvas, Tasks, and reader addresses', () => {
  expect(locationFor('planning')).toBe('/workspace?canvas=planning&filter=mine#section');
  expect(locationFor('planning', '', 'tasks')).toBe('/workspace?canvas=planning&view=tasks&filter=mine#section');
  expect(locationFor('planning', 'source', 'tasks')).toBe('/workspace?canvas=planning&doc=source&filter=mine#section');
  expect(locationFor('')).toBe('/workspace?filter=mine#section');
});
