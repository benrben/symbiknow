// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanvasTask } from '../shared/types';
import { TasksCanvasBoard } from './TasksCanvasBoard';

type MockNode = { id: string; type?: string; position: { x: number; y: number };
  data?: { task?: CanvasTask; onSelect?: (id: string) => void } };

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, onNodeDragStop, children }: {
    nodes: MockNode[]; onNodeDragStop: (event: TouchEvent, node: MockNode) => void; children: React.ReactNode;
  }) => <div>{nodes.map(node => <div key={node.id}><button type="button" onClick={() =>
    onNodeDragStop({ changedTouches: [] } as unknown as TouchEvent, node)}>{`Drop ${node.id}`}</button>
    {node.type === 'taskCard' && node.data?.onSelect && <button type="button" onClick={() =>
      node.data?.onSelect?.(node.id)}>{`Open ${node.data.task?.title}`}</button>}</div>)}
    {nodes.find(node => node.type === 'taskCard') && <>
      <button type="button" onClick={() => onNodeDragStop({ changedTouches: [] } as unknown as TouchEvent,
        { ...nodes.find(node => node.type === 'taskCard')!, position: { x: 750, y: 92 } })}>Drop into Blocked</button>
      <button type="button" onClick={() => onNodeDragStop({ changedTouches: [] } as unknown as TouchEvent,
        { id: 'missing', type: 'taskCard', position: { x: 750, y: 92 } })}>Drop missing card</button>
    </>}{children}</div>,
  applyNodeChanges: (_changes: unknown, nodes: MockNode[]) => nodes,
  Background: ({ color }: { color: string }) => <div data-testid="board-grid-color" data-color={color}/>,
  Controls: () => null,
  MiniMap: () => null,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('ignores column, missing-card, and unchanged drops, then saves a dragged task without replacing its neighbor', async () => {
  const seed = (id: string, boardOrder: number): CanvasTask => ({
    id, title: id, detail: '', status: 'todo', boardOrder, blockIds: [], createdBy: 'Fixture', updatedBy: 'Fixture',
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z', comments: [], revision: 1,
  });
  const tasks = [seed('first', 0), seed('second', 1000)];
  const updates: Array<{ status: string; boardOrder: number; expectedRevision: number }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init: RequestInit) => {
    if (init.method === 'PUT') {
      const patch = JSON.parse(String(init.body)) as typeof updates[number];
      updates.push(patch);
      tasks[0] = { ...tasks[0], status: patch.status as CanvasTask['status'], boardOrder: patch.boardOrder, revision: 2 };
      return Response.json(tasks[0]);
    }
    return Response.json(tasks);
  }));
  const view = render(<TasksCanvasBoard canvasId="board" theme="light"/>);
  await screen.findByRole('button', { name: 'Drop first' });
  expect(screen.getByTestId('board-grid-color').getAttribute('data-color')).toBe('#D6DEDC');
  fireEvent.click(screen.getByRole('button', { name: 'Drop column:todo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Drop missing card' }));
  fireEvent.click(screen.getByRole('button', { name: 'Drop first' }));
  expect(updates).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Drop into Blocked' }));
  await waitFor(() => expect(updates).toEqual([{ status: 'blocked', boardOrder: 0, expectedRevision: 1 }]));
  expect(screen.getByRole('button', { name: 'Drop second' })).toBeTruthy();
  view.rerender(<TasksCanvasBoard canvasId="board" theme="dark"/>);
  expect(screen.getByTestId('board-grid-color').getAttribute('data-color')).toBe('#2D4649');
});

it('shows a linked document identifier when its title is unavailable', async () => {
  const linked: CanvasTask = { id: 'linked', title: 'Linked task', detail: '', status: 'todo', boardOrder: 0,
    blockIds: ['historical-document'], createdBy: 'Fixture', updatedBy: 'Fixture',
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z', comments: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/history?')
    ? Response.json({ items: [{ eventId: 'past-delete', kind: 'deleted', actor: 'Fixture', at: linked.updatedAt,
      taskId: linked.id, before: linked }] }) : Response.json([linked])));
  render(<TasksCanvasBoard canvasId="board" theme="light"/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Linked task' }));
  const details = screen.getByRole('complementary', { name: 'Task details' });
  expect(details.querySelector('.task-canvas-document-link')?.textContent).toBe('historical-document');
  expect(await screen.findByText('todo → Deleted')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'historical-document' }));
});

it('uses the legacy revision fallback for guarded status changes and Undo', async () => {
  const legacy: CanvasTask = { id: 'legacy', title: 'Legacy task', detail: '', status: 'todo', boardOrder: 0,
    blockIds: [], createdBy: 'Fixture', updatedBy: 'Fixture', createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z', comments: [] };
  let current = legacy;
  const sent: Array<{ route: string; expectedRevision: number }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
    const route = String(input);
    if (route.includes('/history?')) return Response.json({ items: [{ eventId: 'edit-1', kind: 'updated',
      actor: 'Fixture', at: legacy.updatedAt, taskId: legacy.id, before: legacy,
      after: { ...legacy, status: 'done' } }] });
    if (init.method === 'PUT' || route.endsWith('/undo')) {
      sent.push({ route, expectedRevision: (JSON.parse(String(init.body)) as { expectedRevision: number }).expectedRevision });
      current = route.endsWith('/undo') ? legacy : { ...legacy, status: 'done' };
      return Response.json(route.endsWith('/undo') ? { task: current } : current);
    }
    return Response.json([current]);
  }));
  render(<TasksCanvasBoard canvasId="board" theme="light"/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Legacy task' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Task status' }), { target: { value: 'done' } });
  await waitFor(() => expect(sent).toHaveLength(1));
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Task status' }) as HTMLSelectElement).disabled).toBe(false));
  fireEvent.click(await screen.findByRole('button', { name: 'Undo this change' }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent.map(item => item.expectedRevision)).toEqual([0, 0]);
  expect((screen.getByRole('combobox', { name: 'Task status' }) as HTMLSelectElement).value).toBe('todo');
});

it('appends a new task after a legacy card with no saved board order', async () => {
  const legacy: CanvasTask = { id: 'legacy', title: 'Legacy task', detail: '', status: 'todo', blockIds: [],
    createdBy: 'Fixture', updatedBy: 'Fixture', createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z', comments: [] };
  const created: CanvasTask[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
    if (String(input).includes('/history?')) return Response.json({ items: [] });
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { title: string; boardOrder: number };
      const task = { ...legacy, id: 'created', title: body.title, boardOrder: body.boardOrder };
      created.push(task);
      return Response.json(task);
    }
    return Response.json([legacy, ...created]);
  }));
  render(<TasksCanvasBoard canvasId="board" theme="light"/>);
  await screen.findByRole('button', { name: 'Open Legacy task' });
  fireEvent.click(screen.getByRole('button', { name: /^Add task$/ }));
  const form = document.querySelector<HTMLFormElement>('.task-canvas-create')!;
  fireEvent.change(form.querySelector('input')!, { target: { value: 'After legacy' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await screen.findByRole('button', { name: 'Open After legacy' });
  expect(created[0].boardOrder).toBe(1000);
});

it('pauses board polling while a dragged status change is awaiting the task service', async () => {
  const task: CanvasTask = { id: 'pending', title: 'Pending task', detail: '', status: 'todo', boardOrder: 0,
    blockIds: [], createdBy: 'Fixture', updatedBy: 'Fixture', createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z', comments: [], revision: 1 };
  let poll: (() => void) | undefined;
  const originalInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout) => {
    if (timeout === 3000) poll = handler as () => void;
    return originalInterval(handler, timeout) as unknown as NodeJS.Timeout;
  });
  let finishSave: ((response: Response) => void) | undefined;
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
    if (String(input).includes('/history?')) return Response.json({ items: [] });
    if (init.method === 'PUT') return new Promise<Response>(resolve => { finishSave = resolve; });
    reads += 1;
    return Response.json([task]);
  }));
  render(<TasksCanvasBoard canvasId="board" theme="light"/>);
  await screen.findByRole('button', { name: 'Drop pending' });
  fireEvent.click(screen.getByRole('button', { name: 'Open Pending task' }));
  expect(reads).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Drop into Blocked' }));
  await waitFor(() => expect(finishSave).toBeTypeOf('function'));
  expect((screen.getByRole('combobox', { name: 'Task status' }) as HTMLSelectElement).disabled).toBe(true);
  await act(async () => { poll!(); });
  expect(reads).toBe(1);
  await act(async () => { finishSave!(Response.json({ ...task, status: 'blocked', revision: 2 })); });
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Task status' }) as HTMLSelectElement).disabled).toBe(false));
  await act(async () => { poll!(); });
  expect(reads).toBe(2);
});

it.each([
  ['success', () => Response.json([{ id: 'old-task', title: 'Old task', detail: '', status: 'todo', boardOrder: 0,
    blockIds: [], createdBy: 'Fixture', updatedBy: 'Fixture', createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z', comments: [] }])],
  ['failure', () => Response.json({ error: 'Old canvas unavailable' }, { status: 503 })],
])('keeps the current canvas when a previous canvas read finishes with %s', async (_case, oldResponse) => {
  let releaseOldRead: ((response: Response) => void) | undefined;
  const currentTask: CanvasTask = { id: 'current-task', title: 'Current task', detail: '', status: 'blocked', boardOrder: 0,
    blockIds: [], createdBy: 'Fixture', updatedBy: 'Fixture', createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z', comments: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/canvases/old/tasks')) return new Promise<Response>(resolve => { releaseOldRead = resolve; });
    return Response.json([currentTask]);
  }));
  const view = render(<TasksCanvasBoard canvasId="old" theme="light"/>);
  view.rerender(<TasksCanvasBoard canvasId="current" theme="light"/>);
  await screen.findByRole('button', { name: 'Drop current-task' });
  await act(async () => { releaseOldRead!(oldResponse()); });
  expect(screen.getByRole('button', { name: 'Drop current-task' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Drop old-task' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});
