import { Background, Controls, MiniMap, ReactFlow, applyNodeChanges, type Node, type NodeProps, type NodeChange } from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasTask, TaskStatus } from '../shared/types';
import { api } from './api';
import type { Theme } from './theme';
import './tasks-canvas.css';

const columns: Array<{ status: TaskStatus; label: string }> = [
  { status: 'todo', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];
const columnWidth = 330;
const columnGap = 36;
const rowHeight = 132;
const taskTop = 92;

type ColumnNode = Node<{ label: string; count: number; status: TaskStatus; onCreate: (status: TaskStatus) => void }, 'taskColumn'>;
type TaskNode = Node<{ task: CanvasTask; onSelect: (id: string) => void }, 'taskCard'>;
type BoardNode = ColumnNode | TaskNode;
type TaskHistoryEvent = { eventId: string; kind: string; actor: string; at: string; taskId: string;
  before?: CanvasTask; after?: CanvasTask; undoOf?: string };

export function orderedTasks(tasks: CanvasTask[], status: TaskStatus): CanvasTask[] {
  return tasks.filter(task => task.status === status).sort((a, b) =>
    (a.boardOrder ?? Number.MAX_SAFE_INTEGER) - (b.boardOrder ?? Number.MAX_SAFE_INTEGER)
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function columnIndex(x: number): number {
  return Math.max(0, Math.min(columns.length - 1, Math.round(x / (columnWidth + columnGap))));
}

function fallbackDrop(fallback: { x: number; y: number }) {
  return { status: columns[columnIndex(fallback.x - 18)].status,
    targetIndex: Math.max(0, Math.round((fallback.y - taskTop) / rowHeight)) };
}

function currentRead(active: boolean, startedVersion: number, currentVersion: number): boolean {
  return active && startedVersion === currentVersion;
}

function nearestColumn(surface: HTMLElement, clientX: number): TaskStatus | undefined {
  const frames = [...surface.querySelectorAll<HTMLElement>('[data-task-column]')];
  const ranked = frames.map((frame, index) => ({ index,
    distance: Math.abs(frame.getBoundingClientRect().left + frame.getBoundingClientRect().width / 2 - clientX) }));
  ranked.sort((a, b) => a.distance - b.distance);
  return ranked[0] ? columns[ranked[0].index].status : undefined;
}

function insertionIndex(surface: HTMLElement, tasks: CanvasTask[], status: TaskStatus, movingId: string, clientY: number): number {
  const siblings = orderedTasks(tasks, status).filter(task => task.id !== movingId);
  const firstAfter = siblings.findIndex(task => {
    const rect = surface.querySelector<HTMLElement>(`[data-id="${task.id}"]`)?.getBoundingClientRect();
    return rect !== undefined && clientY < rect.top + rect.height / 2;
  });
  return firstAfter < 0 ? siblings.length : firstAfter;
}

export function dropPosition(event: MouseEvent | TouchEvent, surface: HTMLElement | null, fallback: { x: number; y: number },
  tasks: CanvasTask[], movingId: string) {
  const point = 'clientX' in event ? event : event.changedTouches[0];
  if (!point || !surface) return fallbackDrop(fallback);
  const status = nearestColumn(surface, point.clientX);
  return status === undefined ? fallbackDrop(fallback)
    : { status, targetIndex: insertionIndex(surface, tasks, status, movingId, point.clientY) };
}

function orderAt(tasks: CanvasTask[], index: number): number | undefined {
  const task = tasks[index];
  return task ? task.boardOrder ?? index * 1000 : undefined;
}

export function nextOrder(tasks: CanvasTask[], status: TaskStatus, targetIndex: number, movingId: string): number {
  const siblings = orderedTasks(tasks, status).filter(task => task.id !== movingId);
  const target = Math.max(0, Math.min(siblings.length, targetIndex));
  const before = orderAt(siblings, target - 1);
  const after = orderAt(siblings, target);
  if (before === undefined) return after === undefined ? 0 : after - 1000;
  if (after === undefined) return before + 1000;
  return (before + after) / 2;
}

async function refreshAfterTaskFailure(cause: unknown, refresh: () => Promise<void>, report: (message: string) => void): Promise<void> {
  const message = (cause as Error).message;
  report(message);
  try { await refresh(); }
  catch (reloadCause) { report(`${message} Saved tasks could not be reloaded: ${(reloadCause as Error).message}`); }
}

function boardNodes(tasks: CanvasTask[], onSelect: (id: string) => void, onCreate: (status: TaskStatus) => void): BoardNode[] {
  const maxCount = Math.max(0, ...columns.map(column => orderedTasks(tasks, column.status).length));
  const height = Math.max(650, taskTop + maxCount * rowHeight + 44);
  return columns.flatMap((column, index): BoardNode[] => {
    const x = index * (columnWidth + columnGap);
    const cards: TaskNode[] = orderedTasks(tasks, column.status).map((task, row) => ({
      id: task.id, type: 'taskCard', position: { x: x + 18, y: taskTop + row * rowHeight },
      data: { task, onSelect }, draggable: true, zIndex: 2,
    }));
    return [{ id: `column:${column.status}`, type: 'taskColumn', position: { x, y: 0 },
      data: { label: column.label, count: cards.length, status: column.status, onCreate },
      style: { width: columnWidth, height }, draggable: false, selectable: true, zIndex: 0 }, ...cards];
  });
}

const TaskColumnNode = memo(function TaskColumnNode({ data }: NodeProps<ColumnNode>) {
  return <div className="task-canvas-column canvas-group" data-task-column={data.status} aria-label={`${data.label}, ${data.count} tasks`}>
    <div className="task-canvas-column__heading"><span className="canvas-group__dot"/><strong>{data.label}</strong><span>{data.count}</span>
      <button type="button" className="nodrag" aria-label={`Add task in ${data.label}`} onClick={() => data.onCreate(data.status)}>+</button></div>
  </div>;
});

const TaskCardNode = memo(function TaskCardNode({ data }: NodeProps<TaskNode>) {
  const { task, onSelect } = data;
  return <button type="button" className="task-canvas-card canvas-card" data-task-id={task.id}
    onClick={() => onSelect(task.id)} aria-label={`Open task ${task.title}`}>
    <span className="task-canvas-card__title">{task.title}</span>
    <span className="task-canvas-card__meta"><span>{task.assignee || 'Unassigned'}</span><span>{task.blockIds.length} linked {task.blockIds.length === 1 ? 'document' : 'documents'}</span></span>
  </button>;
});

const nodeTypes = { taskColumn: TaskColumnNode, taskCard: TaskCardNode };

function TaskDetails({ task, canvasId, busy, documentTitles, onOpenDocument, onClose, onSave, onComment, onUndo }: {
  task: CanvasTask; canvasId: string; busy: boolean; onClose: () => void;
  documentTitles: Record<string, string>; onOpenDocument?: (blockId: string) => void;
  onSave: (task: CanvasTask, patch: Record<string, unknown>) => Promise<void>;
  onComment: (task: CanvasTask, text: string) => Promise<boolean>;
  onUndo: (task: CanvasTask, eventId: string) => Promise<void>;
}) {
  const [comment, setComment] = useState('');
  const [history, setHistory] = useState<TaskHistoryEvent[]>([]);
  const [historyError, setHistoryError] = useState('');
  useEffect(() => {
    let active = true;
    void api<{ items: TaskHistoryEvent[] }>(`/canvases/${encodeURIComponent(canvasId)}/tasks/${encodeURIComponent(task.id)}/history?limit=25`)
      .then(result => { if (active) { setHistory(result.items); setHistoryError(''); } })
      .catch(cause => { if (active) setHistoryError((cause as Error).message); });
    return () => { active = false; };
  }, [canvasId, task.id, task.revision]);
  return <aside className="task-canvas-details" aria-label="Task details">
    <header><h2>{task.title}</h2><button type="button" aria-label="Close task details" onClick={onClose}>×</button></header>
    <label>Status<select aria-label="Task status" value={task.status} disabled={busy} onChange={event => void onSave(task, { status: event.target.value })}>
      {columns.map(column => <option key={column.status} value={column.status}>{column.label}</option>)}
    </select></label>
    <p>{task.detail || 'No details yet.'}</p>
    <dl><dt>Assignee</dt><dd>{task.assignee || 'Unassigned'}</dd><dt>Linked documents</dt><dd>{task.blockIds.length
      ? task.blockIds.map(blockId => <button key={blockId} type="button" className="task-canvas-document-link" onClick={() => onOpenDocument?.(blockId)}>{documentTitles[blockId] ?? blockId}</button>)
      : 'None'}</dd></dl>
    <h3>Comments</h3>
    <div className="task-canvas-comments">{task.comments.map((item, index) => <p key={`${item.createdAt}:${index}`}><strong>{item.author}</strong> {item.text}</p>)}</div>
    <form onSubmit={event => { event.preventDefault(); if (!comment.trim()) return; void onComment(task, comment).then(saved => { if (saved) setComment(''); }); }}>
      <label>Add a comment<textarea value={comment} onChange={event => setComment(event.target.value)} maxLength={2000}/></label>
      <button type="submit" disabled={busy || !comment.trim()}>Add comment</button>
    </form>
    <details className="task-canvas-history"><summary>History · {history.length}</summary>
      {historyError && <p role="alert">{historyError}</p>}
      {history.map(event => <article key={event.eventId} data-task-event-id={event.eventId}>
        <p><strong>{event.kind.replaceAll('_', ' ')}</strong> by {event.actor} · <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time></p>
        {event.before?.status !== event.after?.status && <p>{event.before?.status ?? 'Created'} → {event.after?.status ?? 'Deleted'}</p>}
        {event.undoOf ? <small>Undid {event.undoOf}</small> : <button type="button" disabled={busy}
          onClick={() => void onUndo(task, event.eventId)}>Undo this change</button>}
      </article>)}
    </details>
  </aside>;
}

function TaskCreator({ status, busy, onClose, onCreate }: {
  status: TaskStatus; busy: boolean; onClose: () => void; onCreate: (status: TaskStatus, title: string, detail: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  return <form className="task-canvas-create" onSubmit={event => { event.preventDefault(); void onCreate(status, title, detail); }}>
    <h2>New task in {columns.find(column => column.status === status)?.label}</h2>
    <label>Title<input autoFocus required maxLength={160} value={title} onChange={event => setTitle(event.target.value)}/></label>
    <label>Details<textarea maxLength={4000} value={detail} onChange={event => setDetail(event.target.value)}/></label>
    <div><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={busy || !title.trim()}>Create task</button></div>
  </form>;
}

export function TasksCanvasBoard({ canvasId, theme, documentTitles = {}, onOpenDocument }: {
  canvasId: string; theme: Theme; documentTitles?: Record<string, string>; onOpenDocument?: (blockId: string) => void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const [tasks, setTasks] = useState<CanvasTask[]>([]);
  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<TaskStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const mutationVersion = useRef(0);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const loaded = await api<CanvasTask[]>(`/canvases/${encodeURIComponent(canvasId)}/tasks`);
    setTasks(loaded);
  }, [canvasId]);

  useEffect(() => {
    let active = true;
    setTasks([]);
    setSelectedId(null);
    setLoading(true);
    const load = async () => {
      const version = mutationVersion.current;
      try {
        const loaded = await api<CanvasTask[]>(`/canvases/${encodeURIComponent(canvasId)}/tasks`);
        if (currentRead(active, version, mutationVersion.current)) { setTasks(loaded); setError(''); }
      } catch (cause) { if (currentRead(active, version, mutationVersion.current)) setError((cause as Error).message); }
      finally { if (active) setLoading(false); }
    };
    void load();
    const interval = window.setInterval(() => { if (active && !busyRef.current) void load(); }, 3000);
    return () => { active = false; window.clearInterval(interval); };
  }, [canvasId]);

  const select = useCallback((id: string) => setSelectedId(id), []);
  const openCreator = useCallback((status: TaskStatus) => setCreating(status), []);
  useEffect(() => setNodes(boardNodes(tasks, select, openCreator)), [tasks, select, openCreator]);
  const selected = useMemo(() => tasks.find(task => task.id === selectedId), [tasks, selectedId]);
  const save = useCallback(async (task: CanvasTask, patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const saved = await api<CanvasTask>(`/canvases/${encodeURIComponent(canvasId)}/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PUT', body: JSON.stringify({ ...patch, expectedRevision: task.revision ?? 0 }),
      });
      mutationVersion.current += 1;
      setTasks(current => current.map(item => item.id === saved.id ? saved : item));
      setError('');
    } catch (cause) {
      setNodes(boardNodes(tasks, select, openCreator));
      await refreshAfterTaskFailure(cause, refresh, setError);
    } finally { setBusy(false); }
  }, [canvasId, refresh, select, openCreator, tasks]);
  const create = useCallback(async (status: TaskStatus, title: string, detail: string) => {
    setBusy(true);
    try {
      const latest = await api<CanvasTask[]>(`/canvases/${encodeURIComponent(canvasId)}/tasks`);
      const order = Math.max(-1000, ...orderedTasks(latest, status).map(task => task.boardOrder ?? 0)) + 1000;
      const task = await api<CanvasTask>(`/canvases/${encodeURIComponent(canvasId)}/tasks`, {
        method: 'POST', body: JSON.stringify({ title: title.trim(), detail, status, boardOrder: order }),
      });
      mutationVersion.current += 1;
      setTasks(current => [...current, task]);
      setCreating(null);
      setSelectedId(task.id);
      setError('');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }, [canvasId]);
  const comment = useCallback(async (task: CanvasTask, text: string) => {
    setBusy(true);
    try {
      const saved = await api<CanvasTask>(`/canvases/${encodeURIComponent(canvasId)}/tasks/${encodeURIComponent(task.id)}/comments`, {
        method: 'POST', body: JSON.stringify({ text: text.trim() }),
      });
      mutationVersion.current += 1;
      setTasks(current => current.map(item => item.id === saved.id ? saved : item));
      return true;
    } catch (cause) { setError((cause as Error).message); return false; }
    finally { setBusy(false); }
  }, [canvasId]);
  const undo = useCallback(async (task: CanvasTask, eventId: string) => {
    setBusy(true);
    try {
      const result = await api<{ task: CanvasTask | null }>(`/canvases/${encodeURIComponent(canvasId)}/tasks/${encodeURIComponent(task.id)}/undo`, {
        method: 'POST', body: JSON.stringify({ eventId, expectedRevision: task.revision ?? 0 }),
      });
      mutationVersion.current += 1;
      if (result.task) setTasks(current => current.map(item => item.id === task.id ? result.task! : item));
      else { setTasks(current => current.filter(item => item.id !== task.id)); setSelectedId(null); }
      setError('');
    } catch (cause) { await refreshAfterTaskFailure(cause, refresh, setError); }
    finally { setBusy(false); }
  }, [canvasId, refresh]);

  return <main className="task-canvas-page">
    <header className="task-canvas-header"><div><span className="eyebrow">CANVAS TASKS</span><h1>Tasks</h1><p>Drag cards between status columns, or use the status control in task details.</p></div>
      <button type="button" onClick={() => setCreating('todo')}>Add task</button></header>
    <nav className="task-canvas-create-nav" aria-label="Create task in a status column">
      {columns.map(column => <button key={column.status} type="button" onClick={() => setCreating(column.status)}>+ {column.label}</button>)}
    </nav>
    {error && <div className="task-canvas-error" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}
    {loading && <p role="status">Loading tasks…</p>}
    <section ref={surfaceRef} className="task-canvas-surface canvas-surface" aria-label="Tasks canvas board">
      <ReactFlow<BoardNode> nodes={nodes} edges={[]} nodeTypes={nodeTypes} colorMode={theme} fitView fitViewOptions={{ padding: .1, maxZoom: 1 }}
        minZoom={.2} maxZoom={2} panOnDrag zoomOnScroll onNodesChange={(changes: NodeChange<BoardNode>[]) => setNodes(current => applyNodeChanges(changes, current) as BoardNode[])}
        onNodeDragStop={(event, node) => {
          if (node.type !== 'taskCard') return;
          const task = tasks.find(item => item.id === node.id);
          if (!task) return;
          const { status, targetIndex } = dropPosition(event, surfaceRef.current, node.position, tasks, task.id);
          if (status === task.status && targetIndex === orderedTasks(tasks, status).findIndex(item => item.id === task.id)) {
            setNodes(boardNodes(tasks, select, openCreator));
            return;
          }
          void save(task, { status, boardOrder: nextOrder(tasks, status, targetIndex, task.id) });
        }}>
        <Background color={theme === 'dark' ? '#2D4649' : '#D6DEDC'} gap={22} size={1.1}/>
        <Controls position="bottom-left" showInteractive={false}/>
        <MiniMap position="bottom-right" pannable zoomable nodeColor={node => node.type === 'taskColumn' ? '#97d4cf' : '#BCE7C9'}/>
      </ReactFlow>
    </section>
    {selected && <TaskDetails key={selected.id} task={selected} canvasId={canvasId} busy={busy} documentTitles={documentTitles} onOpenDocument={onOpenDocument}
      onClose={() => setSelectedId(null)} onSave={save} onComment={comment} onUndo={undo}/>}
    {creating && <TaskCreator status={creating} busy={busy} onClose={() => setCreating(null)} onCreate={create}/>}
  </main>;
}
