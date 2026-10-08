// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TodoCanvas } from './TodoCanvas';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';
import { api } from './api';
import type { CanvasTask } from '../shared/types';

afterEach(async () => { cleanup(); await closeWorkspaceFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function show() {
  const fixture = await workspaceFixture();
  const view = render(<TodoCanvas canvasId={fixture.canvas.id} canvasName={fixture.canvas.name} />);
  await screen.findByText('Make room for your next move');
  return { fixture, view, path: `/canvases/${fixture.canvas.id}/todos` };
}
function field(name: string, value: string) { fireEvent.change(screen.getByLabelText(name, { exact: true }), { target: { value } }); }
async function add(title: string) {
  fireEvent.click(screen.getByRole('button', { name: 'New task' })); field('Task title', title);
  fireEvent.click(screen.getByRole('button', { name: 'Save task' })); await screen.findByRole('button', { name: `Edit ${title}` });
}
function titles() { return screen.getAllByRole('article').map(row => within(row).getByRole('button', { name: /^Edit / }).textContent); }

it('creates a complete task, edits it, automatically archives done work and restores it after reload', async () => {
  const { fixture, view, path } = await show();
  fireEvent.click(screen.getByRole('button', { name: 'Add your first task' }));
  field('Task title', 'בדיקת שחרור'); field('Description', 'Ship the release'); field('Priority', 'urgent'); field('Size', 'xl'); field('Due date', '2000-01-02'); field('Status', 'in_progress'); field('Assignee', 'Ben');
  fireEvent.click(screen.getByRole('button', { name: 'Save task' })); await screen.findByRole('button', { name: 'Edit בדיקת שחרור' });
  const [created] = await api<CanvasTask[]>(path); expect(created).toMatchObject({ title: 'בדיקת שחרור', size: 'xl', priority: 'urgent', status: 'in_progress', dueDate: '2000-01-02', assignee: 'Ben' });
  expect(within(screen.getByRole('article')).getByText(/Overdue$/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit בדיקת שחרור' })); field('Task title', 'Ready to ship'); field('Due date', ''); field('Status', 'blocked');
  fireEvent.click(screen.getByRole('button', { name: 'Save task' })); await screen.findByRole('button', { name: 'Complete Ready to ship' });
  fireEvent.click(screen.getByRole('button', { name: 'Complete Ready to ship' })); await screen.findByText('Make room for your next move');
  fireEvent.click(screen.getByRole('button', { name: /Archive 1/ })); await screen.findByRole('button', { name: 'Restore Ready to ship' });
  view.unmount(); render(<TodoCanvas canvasId={fixture.canvas.id} canvasName={fixture.canvas.name} />);
  await screen.findByText('Make room for your next move'); fireEvent.click(screen.getByRole('button', { name: /Archive 1/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore Ready to ship' })); await screen.findByText('A home for finished work');
  fireEvent.click(screen.getByRole('button', { name: /Active 1/ })); await screen.findByRole('button', { name: 'Complete Ready to ship' });
  expect((await api<CanvasTask[]>(path))[0]).toMatchObject({ title: 'Ready to ship', status: 'todo' });
});

it('switches list and board layouts, searches all task text, sorts, cancels editors and explains empty archives', async () => {
  const { path } = await show();
  fireEvent.click(screen.getByRole('button', { name: /Archive 0/ })); expect(screen.getByText('A home for finished work')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Active 0/ })); await add('Normal task');
  await act(async () => { await api(path, { method: 'POST', body: JSON.stringify({ title: 'Urgent task', priority: 'urgent', size: 'xs', dueDate: '2027-01-01', detail: 'Release' }) }); });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' })); await screen.findByRole('button', { name: 'Edit Urgent task' });
  expect(titles()[0]).toContain('Urgent task'); field('Sort tasks', 'size'); expect(titles()[0]).toContain('Urgent task'); field('Sort tasks', 'due'); expect(titles()[0]).toContain('Urgent task'); field('Sort tasks', 'newest'); expect(titles()[0]).toContain('Urgent task');
  field('Search tasks', 'release'); expect(screen.getAllByRole('article')).toHaveLength(1); field('Search tasks', 'absent'); expect(screen.getByText('No matching tasks')).toBeTruthy(); field('Search tasks', '');
  fireEvent.click(screen.getByRole('button', { name: 'Board view' })); expect(screen.getByRole('region', { name: 'To do' })).toBeTruthy(); expect(screen.getAllByText('Nothing here yet')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'List view' })); fireEvent.click(screen.getByRole('button', { name: 'Edit Normal task' })); fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'New task' })); fireEvent.click(screen.getByRole('button', { name: 'Close task editor' })); expect(screen.queryByLabelText('Task title')).toBeNull();
});

it('preserves a failed new-task draft and recovers through retry without losing its fields', async () => {
  const { path } = await show(); const transport = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json({ error: 'Task service is offline' }, { status: 503 }) : transport(input, init));
  fireEvent.click(screen.getByRole('button', { name: 'New task' })); field('Task title', 'Preserve my draft'); field('Description', 'Keep this context'); fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  await screen.findByRole('alert'); expect((screen.getByLabelText('Task title') as HTMLInputElement).value).toBe('Preserve my draft'); expect(screen.getByText(/Your draft is preserved/)).toBeTruthy();
  vi.stubGlobal('fetch', transport); fireEvent.click(screen.getByRole('button', { name: 'Retry / refresh tasks' })); await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Save task' })); await screen.findByRole('button', { name: 'Edit Preserve my draft' }); expect((await api<CanvasTask[]>(path))[0].detail).toBe('Keep this context');
});

it('keeps a captured edit revision through automatic refresh, preserves conflicts, and rebases only on explicit refresh', async () => {
  const { fixture, path } = await show(); await add('Shared task');
  fireEvent.click(screen.getByRole('button', { name: 'Edit Shared task' })); field('Task title', 'My preserved edit');
  const [original] = await api<CanvasTask[]>(path);
  await act(async () => { await api(`${path}/${original.id}`, { method: 'PUT', body: JSON.stringify({ detail: 'Agent update', expectedRevision: original.revision }) }); window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(screen.getByText('Agent update')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Save task' })); await screen.findByRole('alert');
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(fixture.calls.filter(call => call.route === `/api${path}` && call.method === 'GET').length).toBeGreaterThan(3)); expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry / refresh tasks' })); await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect((screen.getByLabelText('Task title') as HTMLInputElement).value).toBe('My preserved edit');
  fireEvent.click(screen.getByRole('button', { name: 'Save task' })); await screen.findByRole('button', { name: 'Edit My preserved edit' }); expect((await api<CanvasTask[]>(path))[0].title).toBe('My preserved edit');
});

it('presents legacy task defaults and keeps an editor draft when a task is removed externally', async () => {
  const { fixture } = await show();
  const task = await fixture.store.createTask(fixture.canvas.id, { title: 'Legacy task', dueDate: '2099-01-01' }, 'Test');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' })); await screen.findByRole('button', { name: 'Edit Legacy task' });
  expect(within(screen.getByRole('article')).getByText('Normal')).toBeTruthy(); expect(within(screen.getByRole('article')).getByText('M')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Board view' })); fireEvent.click(screen.getByRole('button', { name: 'Edit Legacy task' })); field('Task title', 'Keep this removed task draft');
  await fixture.store.deleteTask(fixture.canvas.id, task.id, 'Test');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' })); await screen.findByText('Make room for your next move');
  fireEvent.click(screen.getByRole('button', { name: 'Save task' })); await screen.findByRole('alert'); expect((screen.getByLabelText('Task title') as HTMLInputElement).value).toBe('Keep this removed task draft');
});
