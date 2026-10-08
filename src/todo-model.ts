import type { CanvasTask, TaskStatus } from '../shared/types';

export type TodoSort = 'priority' | 'due' | 'size' | 'newest';
export type TodoInput = Pick<CanvasTask, 'title' | 'detail' | 'status' | 'priority' | 'size' | 'assignee'> & { dueDate: string | null };
export const statusLabels: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Archived' };
export const priorityLabels = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
export const sizeLabels = { xs: 'XS', s: 'S', m: 'M', l: 'L', xl: 'XL' };
const priorities = { urgent: 0, high: 1, normal: 2, low: 3 };
const sizes = { xs: 0, s: 1, m: 2, l: 3, xl: 4 };
export const activeStatuses: TaskStatus[] = ['todo', 'in_progress', 'blocked'];

export function todayDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function overdue(task: CanvasTask, today = todayDate()) {
  return task.status !== 'done' && Boolean(task.dueDate) && task.dueDate! < today;
}

export function dueLabel(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(year, month - 1, day));
}

const sortValues: Record<TodoSort, (task: CanvasTask) => number | string> = {
  priority: task => priorities[task.priority ?? 'normal'], size: task => sizes[task.size ?? 'm'],
  due: task => task.dueDate ?? '9999-12-31', newest: task => -Date.parse(task.createdAt),
};

export function visibleTodos(tasks: CanvasTask[], archived: boolean, query: string, sort: TodoSort) {
  const search = query.trim().toLocaleLowerCase();
  return tasks.filter(task => (task.status === 'done') === archived)
    .filter(task => `${task.title} ${task.detail} ${task.assignee ?? ''}`.toLocaleLowerCase().includes(search))
    .sort((left, right) => {
      const a = sortValues[sort](left); const b = sortValues[sort](right);
      if (a < b) return -1;
      if (a > b) return 1;
      return left.title.localeCompare(right.title);
    });
}

export function todoCounts(tasks: CanvasTask[]) {
  return { active: tasks.filter(task => task.status !== 'done').length, archived: tasks.filter(task => task.status === 'done').length,
    progress: tasks.filter(task => task.status === 'in_progress').length, overdue: tasks.filter(task => overdue(task)).length };
}

export function todoFormInput(form: HTMLFormElement): TodoInput {
  const data = new FormData(form);
  return { title: String(data.get('title')).trim(), detail: String(data.get('detail')), assignee: String(data.get('assignee')).trim(),
    priority: String(data.get('priority')) as CanvasTask['priority'], size: String(data.get('size')) as CanvasTask['size'],
    status: String(data.get('status')) as TaskStatus, dueDate: String(data.get('dueDate')) || null };
}
