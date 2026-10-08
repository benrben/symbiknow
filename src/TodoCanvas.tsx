import { useState } from 'react';
import { Archive, ArrowUpDown, CheckCheck, LayoutGrid, List, Plus, RefreshCw, Search } from 'lucide-react';
import type { CanvasTask } from '../shared/types';
import { TodoForm } from './todo-form';
import { TodoItems } from './todo-items';
import { todoCounts, visibleTodos, type TodoSort } from './todo-model';
import { useTodos } from './useTodos';
import './todos.css';

export function TodoCanvas({ canvasId, canvasName }: { canvasId: string; canvasName: string }) {
  const todos = useTodos(canvasId);
  const [archived, setArchived] = useState(false);
  const [board, setBoard] = useState(false);
  const [sort, setSort] = useState<TodoSort>('priority');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<CanvasTask | 'new' | null>(null);
  const counts = todoCounts(todos.tasks);
  const tasks = visibleTodos(todos.tasks, archived, query, sort);
  const refresh = async () => {
    const next = await todos.refresh();
    if (next && editor && editor !== 'new') setEditor(next.find(task => task.id === editor.id) ?? editor);
  };
  return <main className="todo-canvas" aria-label={`Tasks for ${canvasName}`}>
    <div className="todo-workspace">
      <header className="todo-heading"><div><span className="todo-eyebrow">YOUR NEXT MOVES</span><h1>Tasks<span className="todo-heading-dot">.</span></h1>
        <p dir="auto">{canvasName} <span aria-hidden="true">/</span> A little clarity. A lot of progress.</p></div>
        <button className="primary-button todo-add" onClick={() => setEditor('new')}><Plus size={17} /> New task</button></header>
      <div className="todo-summary" aria-label="Task summary">
        <div><strong>{counts.active}</strong><span>Open tasks</span></div><div><strong>{counts.progress}</strong><span>In progress</span></div>
        <div className="todo-summary-due"><strong>{counts.overdue}</strong><span>Overdue</span></div><div><strong>{counts.archived}</strong><span>Completed & archived</span></div>
      </div>
      <div className="todo-controls"><div className="todo-tabs" aria-label="Task collection">
        <button aria-pressed={!archived} onClick={() => setArchived(false)}><CheckCheck size={16} /> Active <span>{counts.active}</span></button>
        <button aria-pressed={archived} onClick={() => setArchived(true)}><Archive size={16} /> Archive <span>{counts.archived}</span></button></div>
        <button className="todo-icon" aria-label="Refresh tasks" onClick={() => { void refresh(); }} disabled={todos.busy}><RefreshCw size={16} /></button>
      </div>
      {todos.error && <div className="todo-error" role="alert"><p>{todos.error}</p><button onClick={() => { void refresh(); }} disabled={todos.busy}>Retry / refresh tasks</button></div>}
      <div className="todo-filters"><label className="todo-search"><Search size={16} /><input aria-label="Search tasks" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a task…" /></label>
        <label className="todo-sort"><ArrowUpDown size={14} /><span>Sort by</span><select aria-label="Sort tasks" value={sort} onChange={event => setSort(event.target.value as TodoSort)}>
          <option value="priority">Priority</option><option value="due">Due date</option><option value="size">Size</option><option value="newest">Newest</option></select></label>
        <div className="todo-layout" aria-label="Task layout"><button aria-label="List view" aria-pressed={!board} onClick={() => setBoard(false)}><List size={17} /></button>
          <button aria-label="Board view" aria-pressed={board} onClick={() => setBoard(true)}><LayoutGrid size={17} /></button></div></div>
      {todos.loading ? <p className="todo-loading" role="status">Loading your tasks…</p> : <TodoContent tasks={tasks} query={query} archived={archived} board={board} busy={todos.busy}
        onEdit={setEditor} onStatus={(task, status) => { void todos.save({ status }, task); }} onAdd={() => setEditor('new')} />}
      {editor && <TodoForm key={editor === 'new' ? 'new' : editor.id} task={editorTask(editor)} busy={todos.busy} error={todos.error} onCancel={() => setEditor(null)}
        onSave={async input => { if (await todos.save(input, editorTask(editor))) setEditor(null); }} />}
    </div>
  </main>;
}

function editorTask(editor: CanvasTask | 'new') {
  if (editor === 'new') return undefined;
  return editor;
}

function TodoContent(props: Parameters<typeof TodoItems>[0] & { query: string; onAdd: () => void }) {
  if (props.tasks.length > 0) return <TodoItems {...props} />;
  if (props.query.trim()) return <div className="todo-empty"><Search size={28} /><h2>No matching tasks</h2><p>Try another title, description, or assignee.</p></div>;
  if (props.archived) return <div className="todo-empty"><Archive size={28} /><h2>A home for finished work</h2><p>Mark an active task done and it will appear here. Restore it whenever you need.</p></div>;
  return <div className="todo-empty"><CheckCheck size={32} /><h2>Make room for your next move</h2><p>Turn an idea into a task. Set its priority, size, and due date to find your focus.</p><button className="primary-button" onClick={props.onAdd}><Plus size={16} /> Add your first task</button></div>;
}
