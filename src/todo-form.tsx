import { useId } from 'react';
import { X } from 'lucide-react';
import type { CanvasTask } from '../shared/types';
import { priorityLabels, sizeLabels, statusLabels, todoFormInput, type TodoInput } from './todo-model';

type Props = { task?: CanvasTask; busy: boolean; error: string; onCancel: () => void; onSave: (input: TodoInput) => Promise<void> };
const emptyTask = { title: '', detail: '', priority: 'normal', size: 'm', dueDate: '', status: 'todo', assignee: '' };
export function TodoForm({ task, busy, error, onCancel, onSave }: Props) {
  const id = useId();
  const initial = { ...emptyTask, ...task };
  return <section className="todo-form-panel" aria-labelledby={`${id}-heading`}>
    <header><div><span className="todo-eyebrow">MAKE IT HAPPEN</span><h2 id={`${id}-heading`}>{task ? 'Edit task' : 'New task'}</h2></div>
      <button type="button" className="todo-icon" aria-label="Close task editor" onClick={onCancel} disabled={busy}><X size={18} /></button></header>
    <form onSubmit={event => { event.preventDefault(); void onSave(todoFormInput(event.currentTarget)); }}>
      <label>Task title<input autoFocus required name="title" maxLength={160} defaultValue={initial.title} placeholder="What needs to happen?" dir="auto" /></label>
      <label>Description<textarea name="detail" maxLength={4000} defaultValue={initial.detail} placeholder="Add context, steps, or a definition of done…" dir="auto" rows={3} /></label>
      <div className="todo-form-grid">
        <label>Priority<select aria-label="Priority" name="priority" defaultValue={initial.priority}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Size<select aria-label="Size" name="size" defaultValue={initial.size}>{Object.entries(sizeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Due date<input name="dueDate" type="date" defaultValue={initial.dueDate} /></label>
        <label>Status<select aria-label="Status" name="status" defaultValue={initial.status}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <label>Assignee<input name="assignee" maxLength={48} defaultValue={initial.assignee} placeholder="Unassigned" dir="auto" /></label>
      <p className="todo-form-hint">Completed tasks move to Archive automatically. You can restore them anytime.</p>
      {error && <p className="todo-form-error" role="status">Your draft is preserved. Resolve the error above, then save again.</p>}
      <footer><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save task'}</button></footer>
    </form>
  </section>;
}
