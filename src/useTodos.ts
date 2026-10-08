import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasTask } from '../shared/types';
import { api } from './api';
import type { TodoInput } from './todo-model';

function writeRequest(path: string, input: Partial<TodoInput>, task?: CanvasTask) {
  if (task) return { path: `${path}/${encodeURIComponent(task.id)}`, init: { method: 'PUT', body: JSON.stringify({ ...input, expectedRevision: task.revision ?? 0 }) } };
  return { path, init: { method: 'POST', body: JSON.stringify(input) } };
}

export function useTodos(canvasId: string) {
  const [tasks, setTasks] = useState<CanvasTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const alive = useRef(false);
  const saving = useRef(false);
  const sequence = useRef(0);
  const path = `/canvases/${encodeURIComponent(canvasId)}/todos`;
  const refresh = useCallback(async (explicit = true) => {
    if (saving.current) return;
    const request = ++sequence.current;
    const current = () => alive.current && request === sequence.current;
    const finishLoading = () => { if (alive.current) setLoading(false); };
    try {
      const next = await api<CanvasTask[]>(path);
      if (!current()) return;
      setTasks(next); setError('');
      if (explicit) setSaveError('');
      return next;
    } catch (cause) {
      if (!current()) return;
      setError((cause as Error).message);
    } finally {
      finishLoading();
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    const automaticRefresh = () => { void refresh(false); };
    automaticRefresh();
    const interval = window.setInterval(automaticRefresh, 20000);
    window.addEventListener('focus', automaticRefresh);
    return () => { alive.current = false; ++sequence.current; window.clearInterval(interval); window.removeEventListener('focus', automaticRefresh); };
  }, [refresh]);

  const save = async (input: Partial<TodoInput>, task?: CanvasTask) => {
    if (saving.current) return false;
    saving.current = true; setBusy(true); setSaveError(''); ++sequence.current;
    const request = writeRequest(path, input, task);
    try {
      const saved = await api<CanvasTask>(request.path, request.init);
      if (!alive.current) return false;
      ++sequence.current;
      setTasks(current => [...current.filter(item => item.id !== saved.id), saved]);
      return true;
    } catch (cause) {
      if (alive.current) setSaveError(`${(cause as Error).message} Your changes are still here. Refresh tasks before retrying if another person or agent changed this task.`);
      return false;
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return { tasks, loading, busy, error: saveError || error, refresh, save };
}
