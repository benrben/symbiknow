// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import type { CanvasTask, TaskStatus } from '../shared/types';
import { dropPosition, nextOrder } from './TasksCanvasBoard';

afterEach(() => { document.body.replaceChildren(); });

function task(id: string, status: TaskStatus, boardOrder?: number): CanvasTask {
  return { id, title: id, detail: '', status, boardOrder, blockIds: [], createdBy: 'Fixture', updatedBy: 'Fixture',
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z', comments: [] };
}

function rect(element: HTMLElement, left: number, top: number, width: number, height: number) {
  element.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height,
    x: left, y: top, toJSON: () => ({}) });
}

function surfaceWithColumns(): HTMLElement {
  const surface = document.createElement('section');
  ['todo', 'in_progress', 'blocked', 'done'].forEach((status, index) => {
    const column = document.createElement('div');
    column.dataset.taskColumn = status;
    rect(column, index * 366, 0, 330, 600);
    surface.append(column);
  });
  document.body.append(surface);
  return surface;
}

function card(surface: HTMLElement, id: string, top: number) {
  const element = document.createElement('div');
  element.dataset.id = id;
  rect(element, 384, top, 294, 112);
  surface.append(element);
}

it('assigns stable order at the start, between cards, at the end, and in an empty status column', () => {
  const tasks = [task('a', 'todo', 1000), task('b', 'todo', 2000), task('moving', 'todo', 1500)];
  expect(nextOrder(tasks, 'blocked', 0, 'moving')).toBe(0);
  expect(nextOrder(tasks, 'todo', 0, 'moving')).toBe(0);
  expect(nextOrder(tasks, 'todo', 1, 'moving')).toBe(1500);
  expect(nextOrder(tasks, 'todo', 20, 'moving')).toBe(3000);
  expect(nextOrder(tasks, 'todo', -5, 'moving')).toBe(0);
  expect(nextOrder([task('missing', 'todo')], 'todo', 1, 'moving')).toBe(1000);
  expect(nextOrder([task('missing', 'todo')], 'todo', 0, 'moving')).toBe(-1000);
});

it('uses card centers to choose the saved column and within-column order at any canvas zoom', () => {
  const surface = surfaceWithColumns();
  card(surface, 'first', 100);
  card(surface, 'second', 232);
  const tasks = [task('first', 'in_progress', 1000), task('second', 'in_progress', 2000), task('moving', 'todo', 0)];
  const drop = (clientX: number, clientY: number) => dropPosition(new MouseEvent('mouseup', { clientX, clientY }),
    surface, { x: 0, y: 0 }, tasks, 'moving');
  expect(drop(530, 100)).toEqual({ status: 'in_progress', targetIndex: 0 });
  expect(drop(530, 200)).toEqual({ status: 'in_progress', targetIndex: 1 });
  expect(drop(530, 400)).toEqual({ status: 'in_progress', targetIndex: 2 });
  expect(drop(880, 200)).toEqual({ status: 'blocked', targetIndex: 0 });
  surface.querySelectorAll('[data-id]').forEach(element => element.remove());
  expect(drop(530, 200)).toEqual({ status: 'in_progress', targetIndex: 2 });
});

it('falls back to the saved canvas position when pointer data or column geometry is unavailable', () => {
  const fallback = { x: 750, y: 224 };
  const mouse = new MouseEvent('mouseup', { clientX: 500, clientY: 200 });
  expect(dropPosition(mouse, null, fallback, [], 'moving')).toEqual({ status: 'blocked', targetIndex: 1 });
  const surface = document.createElement('section');
  expect(dropPosition(mouse, surface, fallback, [], 'moving')).toEqual({ status: 'blocked', targetIndex: 1 });
  const noTouchPoint = { changedTouches: [] } as unknown as TouchEvent;
  expect(dropPosition(noTouchPoint, surface, { x: -100, y: -100 }, [], 'moving'))
    .toEqual({ status: 'todo', targetIndex: 0 });
  const touch = { changedTouches: [{ clientX: 1220, clientY: 40 }] } as unknown as TouchEvent;
  expect(dropPosition(touch, surfaceWithColumns(), fallback, [], 'moving'))
    .toEqual({ status: 'done', targetIndex: 0 });
});
