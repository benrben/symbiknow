import { describe, expect, it, vi } from 'vitest';
import type { CanvasTask } from '../shared/types';
import { dueLabel, overdue, todayDate, todoCounts, visibleTodos } from './todo-model';

function task(title: string, input: Partial<CanvasTask> = {}): CanvasTask {
  return { id: title, title, detail: '', status: 'todo', blockIds: [], createdBy: 'Test', updatedBy: 'Test', createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z', comments: [], ...input };
}
describe('task presentation', () => {
  it('uses a local calendar day and formats calendar dates without UTC shifts', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 0, 3, 12));
    expect(todayDate()).toBe('2026-01-03'); expect(dueLabel('2026-01-03')).toMatch(/2026/);
    expect(overdue(task('Old', { dueDate: '2026-01-02' }))).toBe(true);
    expect(overdue(task('Today', { dueDate: '2026-01-03' }))).toBe(false);
    expect(overdue(task('No date'))).toBe(false); expect(overdue(task('Done', { status: 'done', dueDate: '2020-01-01' }))).toBe(false);
    vi.useRealTimers();
  });
  it('sorts dates, priorities, sizes, and creation time with stable title ties and defaults', () => {
    const items = [task('Zulu'), task('Alpha', { priority: 'urgent', size: 'xl', dueDate: '2026-10-07', createdAt: '2026-10-05T00:00:00Z' }),
      task('Beta', { priority: 'low', size: 'xs', dueDate: '2026-10-02' }), task('Default'), task('Done', { status: 'done' })];
    expect(visibleTodos(items, false, '', 'priority').map(item => item.title)).toEqual(['Alpha', 'Default', 'Zulu', 'Beta']);
    expect(visibleTodos(items, false, '', 'due').map(item => item.title)).toEqual(['Beta', 'Alpha', 'Default', 'Zulu']);
    expect(visibleTodos(items, false, '', 'size').map(item => item.title)).toEqual(['Beta', 'Default', 'Zulu', 'Alpha']);
    expect(visibleTodos(items, false, '', 'newest')[0].title).toBe('Alpha');
    expect(visibleTodos(items, true, ' done ', 'priority')[0].title).toBe('Done');
    expect(visibleTodos([task('Title', { assignee: 'Rachel', detail: 'Release guide' })], false, 'rachel', 'priority')).toHaveLength(1);
    expect(visibleTodos(items, false, 'missing', 'priority')).toEqual([]);
  });
  it('counts only active deadlines and distinguishes work in progress from archived work', () => {
    expect(todoCounts([task('Overdue', { dueDate: '2000-01-01' }), task('Working', { status: 'in_progress' }), task('Done', { status: 'done' })])).toEqual({ active: 2, archived: 1, progress: 1, overdue: 1 });
  });
});
