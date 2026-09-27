import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, ChevronDown, Circle, CircleDashed, CircleSlash, FileText, LoaderCircle, MessageSquare, Plus, Trash2 } from 'lucide-react';
import type { CanvasDocument, CanvasTask, TaskStatus } from '../shared/types';
import type { TaskInsightReport, TaskScore, TaskSuggestion } from '../shared/insights';
import { api, browserActor } from './api';
import './tasks.css';

const statusInfo: Record<TaskStatus, { label: string; icon: typeof Circle }> = {
  todo: { label: 'To do', icon: Circle },
  in_progress: { label: 'In progress', icon: CircleDashed },
  blocked: { label: 'Blocked', icon: CircleSlash },
  done: { label: 'Done', icon: CheckCircle2 },
};
const order: TaskStatus[] = ['in_progress', 'todo', 'blocked', 'done'];

function relative(value: string): string {
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : new Date(value).toLocaleDateString();
}

function TaskCard({ task, canvas, onChange, onOpenBlock, score, suggestions }: {
  task: CanvasTask;
  canvas: CanvasDocument;
  onChange: (route: string, init: RequestInit) => Promise<void>;
  onOpenBlock: (blockId: string) => void;
  score?: TaskScore;
  suggestions: TaskSuggestion[];
}) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const base = `/canvases/${encodeURIComponent(canvas.id)}/tasks/${encodeURIComponent(task.id)}`;
  const Icon = statusInfo[task.status].icon;
  return <article className={`task-card task-card--${task.status}`}>
    <div className="task-card__main">
      <button type="button" className="task-card__check" aria-label={task.status === 'done' ? `Reopen ${task.title}` : `Mark ${task.title} done`}
        onClick={() => void onChange(base, { method: 'PUT', body: JSON.stringify({ status: task.status === 'done' ? 'todo' : 'done' }) })}><Icon size={16}/></button>
      <div className="task-card__body">
        <strong>{task.title}</strong>
        {task.detail && <p>{task.detail}</p>}
        <div className="task-card__meta">
          {task.assignee ? <span className="task-chip task-chip--owner">{task.assignee}</span> : <span className="task-chip">Unassigned</span>}
          <span>by {task.createdBy} · {relative(task.updatedAt)}</span>
          {score && <span>Priority {Math.round(score.priority * 100)}% · Effort {Math.round(score.effort * 100)}%{score.blocked >= 0.7 ? ' · Likely blocked' : ''}</span>}
        </div>
        {suggestions.map(suggestion => <div key={suggestion.id} className="task-card__suggestion">
          <span>{suggestion.title} ({Math.round(suggestion.confidence * 100)}%)</span>
          <button type="button" className="secondary-button"
            onClick={() => void onChange(base, { method: 'PUT', body: JSON.stringify(suggestion.proposedAction.patch) })}>Apply</button>
        </div>)}
        {task.blockIds.length > 0 && <div className="task-card__docs">{task.blockIds.map(id => {
          const title = canvas.blocks.find(block => block.id === id)?.title;
          return title ? <button key={id} type="button" onClick={() => onOpenBlock(id)}><FileText size={11} aria-hidden="true"/>{title}</button> : null;
        })}</div>}
      </div>
      <button type="button" className="task-card__expand" aria-expanded={open} aria-label={`Details for ${task.title}`} onClick={() => setOpen(value => !value)}>
        {task.comments.length > 0 && <span><MessageSquare size={12} aria-hidden="true"/>{task.comments.length}</span>}<ChevronDown size={14} aria-hidden="true"/></button>
    </div>
    {open && <div className="task-card__details">
      <div className="task-card__controls">
        <select aria-label={`Status for ${task.title}`} value={task.status} onChange={event => void onChange(base, { method: 'PUT', body: JSON.stringify({ status: event.target.value }) })}>
          {order.map(status => <option key={status} value={status}>{statusInfo[status].label}</option>)}</select>
        {task.assignee !== browserActor && <button type="button" className="secondary-button" onClick={() => void onChange(`${base}/claim`, { method: 'POST', body: JSON.stringify({ force: true }) })}>Assign to me</button>}
        <button type="button" className="icon-button" aria-label={`Delete ${task.title}`} onClick={() => void onChange(base, { method: 'DELETE' })}><Trash2 size={14}/></button>
      </div>
      {task.comments.length > 0 && <ol className="task-card__comments">{task.comments.map((item, index) => <li key={index}><strong>{item.author}</strong><span>{item.text}</span><small>{relative(item.createdAt)}</small></li>)}</ol>}
      <form className="task-card__comment" onSubmit={event => { event.preventDefault(); if (!comment.trim()) return;
        void onChange(`${base}/comments`, { method: 'POST', body: JSON.stringify({ text: comment.trim() }) }).then(() => setComment('')); }}>
        <input aria-label={`Comment on ${task.title}`} value={comment} onChange={event => setComment(event.target.value)} placeholder="Add a note for people and agents…"/>
        <button className="secondary-button" disabled={!comment.trim()}>Post</button>
      </form>
    </div>}
  </article>;
}

/** The shared board. Agents update it over MCP, so it refreshes every few seconds while visible. */
export function TasksPanel({ canvas, visible, onOpenBlock }: { canvas: CanvasDocument | null; visible: boolean; onOpenBlock: (blockId: string) => void }) {
  const [tasks, setTasks] = useState<CanvasTask[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [taskInsights, setTaskInsights] = useState<TaskInsightReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [sortBy, setSortBy] = useState<'status' | 'priority_effort'>('status');
  const canvasId = canvas?.id ?? '';
  const latest = useRef(canvasId);
  latest.current = canvasId;

  const load = useCallback(async () => {
    if (!canvasId) return;
    try {
      const next = await api<CanvasTask[]>(`/canvases/${encodeURIComponent(canvasId)}/tasks`);
      if (latest.current === canvasId) setTasks(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    } catch (failure) { if (latest.current === canvasId) setError(failure instanceof Error ? failure.message : 'Could not load tasks.'); }
  }, [canvasId]);

  useEffect(() => { setTasks(null); setTaskInsights(null); setError(''); }, [canvasId]);
  useEffect(() => {
    if (!visible || !canvasId) return;
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [visible, canvasId, load]);

  async function change(route: string, init: RequestInit) {
    setError('');
    try { await api(route, init); await load(); setTaskInsights(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not update the task.'); }
  }

  async function analyze() {
    if (!canvasId) return;
    setAnalyzing(true);
    setError('');
    try { setTaskInsights(await api<TaskInsightReport>(`/canvases/${encodeURIComponent(canvasId)}/tasks/insights`)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not analyze tasks.'); }
    finally { setAnalyzing(false); }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !canvasId) return;
    await change(`/canvases/${encodeURIComponent(canvasId)}/tasks`, { method: 'POST', body: JSON.stringify({ title: title.trim() }) });
    setTitle('');
  }

  if (!canvas) return <div className="tasks-panel tasks-panel--empty"><p>Open a canvas to see its tasks.</p></div>;
  const open = (tasks ?? []).filter(task => task.status !== 'done').length;
  return <div className="tasks-panel">
    <div className="tasks-panel__intro"><h2>Shared tasks</h2><p>People, Codex, and Claude Code claim and update the same board over MCP.</p></div>
    <form className="tasks-panel__new" onSubmit={event => void create(event)}>
      <Plus size={15} aria-hidden="true"/><input aria-label="New task" value={title} onChange={event => setTitle(event.target.value)} placeholder="Add a task…"/>
      <button className="primary-button" disabled={!title.trim()}>Add</button>
    </form>
    <div className="tasks-panel__analysis">
      <button type="button" className="secondary-button" disabled={analyzing} onClick={() => void analyze()}>
        {analyzing ? 'Analyzing tasks…' : 'Analyze tasks with Jev'}</button>
      {taskInsights && <label>Sort <select aria-label="Sort tasks" value={sortBy}
        onChange={event => setSortBy(event.target.value as 'status' | 'priority_effort')}>
        <option value="status">Status</option><option value="priority_effort">Priority per effort</option>
      </select></label>}
    </div>
    {error && <p className="tasks-panel__error" role="alert">{error}</p>}
    {tasks === null ? <p className="tasks-panel__loading"><LoaderCircle size={14} className="insights-spin" aria-hidden="true"/>Loading tasks…</p>
      : tasks.length === 0 ? <div className="tasks-panel__empty-state"><CheckCircle2 size={22} aria-hidden="true"/><p>No tasks yet. Add one here, or ask an agent to create tasks with <code>create_task</code>.</p></div>
        : <div className="tasks-panel__groups">{order.filter(status => status !== 'done' || showDone).map(status => {
          const items = tasks.filter(task => task.status === status).sort((a, b) => sortBy === 'priority_effort'
            ? (taskInsights?.scores[b.id]?.priorityPerEffort ?? -Infinity) - (taskInsights?.scores[a.id]?.priorityPerEffort ?? -Infinity) : 0);
          if (!items.length) return null;
          return <section key={status} aria-label={statusInfo[status].label}><h3>{statusInfo[status].label}<span>{items.length}</span></h3>
            {items.map(task => <TaskCard key={task.id} task={task} canvas={canvas} onChange={change} onOpenBlock={onOpenBlock}
              score={taskInsights?.scores[task.id]} suggestions={taskInsights?.items.filter(item => item.id.endsWith(`-${task.id}`)) ?? []}/>)}</section>;
        })}
        <button type="button" className="tasks-panel__toggle-done" onClick={() => setShowDone(value => !value)}>
          {showDone ? 'Hide done' : `Show done (${tasks.length - open})`}</button></div>}
  </div>;
}
