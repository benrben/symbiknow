import { CalendarDays, Check, RotateCcw } from 'lucide-react';
import type { CanvasTask } from '../shared/types';
import { activeStatuses, dueLabel, overdue, priorityLabels, sizeLabels, statusLabels } from './todo-model';

type ItemProps = { task: CanvasTask; busy: boolean; onEdit: (task: CanvasTask) => void; onStatus: (task: CanvasTask, status: CanvasTask['status']) => void };
export function TodoItem({ task, busy, onEdit, onStatus }: ItemProps) {
  const archived = task.status === 'done';
  return <article className={`todo-item todo-priority-${task.priority ?? 'normal'}`} data-task-id={task.id}>
    {archived ? <button className="todo-restore" disabled={busy} onClick={() => onStatus(task, 'todo')} aria-label={`Restore ${task.title}`}><RotateCcw size={15} /> Restore</button>
      : <button className="todo-complete" disabled={busy} onClick={() => onStatus(task, 'done')} aria-label={`Complete ${task.title}`}><Check size={14} /></button>}
    <button className="todo-item-content" onClick={() => onEdit(task)} aria-label={`Edit ${task.title}`}>
      <strong dir="auto">{task.title}</strong>{task.detail && <span className="todo-item-detail" dir="auto">{task.detail}</span>}
      <TodoMetadata task={task} />
    </button>
  </article>;
}

function TodoMetadata({ task }: { task: CanvasTask }) {
  return <span className="todo-item-meta"><span className="todo-status">{statusLabels[task.status]}</span><span className="todo-priority">{priorityLabels[task.priority ?? 'normal']}</span>
    <span className="todo-size" title="Task size">{sizeLabels[task.size ?? 'm']}</span>
    {task.dueDate && <TodoDue task={task} date={task.dueDate} />}
    {task.assignee && <span className="todo-assignee" dir="auto">{task.assignee}</span>}
  </span>;
}

function TodoDue({ task, date }: { task: CanvasTask; date: string }) {
  const late = overdue(task);
  return <span className={`todo-due ${late ? 'is-overdue' : ''}`}><CalendarDays size={12} /><time dateTime={date}>{dueLabel(date)}</time>{late && ' · Overdue'}</span>;
}

type ItemsProps = Omit<ItemProps, 'task'> & { tasks: CanvasTask[]; board: boolean; archived: boolean };
export function TodoItems({ tasks, board, archived, ...actions }: ItemsProps) {
  if (!board || archived) return <div className="todo-list">{tasks.map(task => <TodoItem key={task.id} task={task} {...actions} />)}</div>;
  return <div className="todo-board">{activeStatuses.map(status => {
    const column = tasks.filter(task => task.status === status);
    return <section className={`todo-column todo-column-${status}`} key={status} aria-label={statusLabels[status]}>
      <h2><span>{statusLabels[status]}</span><span>{column.length}</span></h2>
      <div>{column.map(task => <TodoItem key={task.id} task={task} {...actions} />)}</div>
      {column.length === 0 && <p className="todo-column-empty">Nothing here yet</p>}
    </section>;
  })}</div>;
}
