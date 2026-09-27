// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CanvasDocument, CanvasTask } from '../shared/types';
import { TasksPanel } from './TasksPanel';

const canvas: CanvasDocument = { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [
  { id: 'faq', title: 'Launch FAQ', file: 'docs/faq.md', kind: 'markdown', content: '# FAQ', x: 0, y: 0, width: 300, height: 200, links: [] },
] };

function task(overrides: Partial<CanvasTask>): CanvasTask {
  const now = new Date().toISOString();
  return { id: 't1', title: 'Write the FAQ', detail: '', status: 'todo', blockIds: [], createdBy: 'Claude Code', updatedBy: 'Claude Code',
    createdAt: now, updatedAt: now, comments: [], ...overrides };
}

let tasks: CanvasTask[];
const requests: Array<{ path: string; method: string; body: unknown }> = [];

beforeEach(() => {
  tasks = [task({ id: 't1', status: 'in_progress', assignee: 'Codex', blockIds: ['faq'], comments: [{ author: 'Codex', text: 'Half done', createdAt: new Date().toISOString() }] }),
    task({ id: 't2', title: 'Ship it', status: 'done' })];
  requests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ path, method, body });
    if (path === '/api/canvases/planning/tasks' && method === 'POST') {
      tasks.push(task({ id: 't3', title: String(body?.title), createdBy: 'Browser' }));
      return Response.json(tasks.at(-1), { status: 201 });
    }
    if (path === '/api/canvases/planning/tasks/insights') return Response.json({
      scores: { t1: { priority: 0.9, effort: 0.2, blocked: 0.1, priorityPerEffort: 4.5 } },
      items: [{ id: 'task-attach-t1', category: 'task', title: 'Attach Launch FAQ to Write the FAQ',
        detail: 'Relevant document', blockIds: ['faq'], confidence: 0.8,
        proposedAction: { type: 'task', taskId: 't1', patch: { blockIds: ['faq'] } } }],
    });
    const match = path.match(/\/tasks\/(t\d)(?:\/(claim|comments))?$/);
    if (match && method === 'PUT') Object.assign(tasks.find(item => item.id === match[1])!, body);
    if (match?.[2] === 'claim') Object.assign(tasks.find(item => item.id === match[1])!, { assignee: 'Browser', status: 'in_progress' });
    return Response.json(tasks);
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('shared task board', () => {
  it('lists agent tasks by status and lets people add, complete, claim, and open related documents', async () => {
    const onOpenBlock = vi.fn();
    render(<TasksPanel canvas={canvas} visible onOpenBlock={onOpenBlock}/>);
    const progress = await screen.findByRole('region', { name: 'In progress' });
    expect(within(progress).getByText('Write the FAQ')).toBeTruthy();
    expect(within(progress).getByText('Codex')).toBeTruthy();
    expect(screen.queryByText('Ship it')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show done (1)' }));
    expect(screen.getByText('Ship it')).toBeTruthy();
    fireEvent.click(within(progress).getByRole('button', { name: 'Launch FAQ' }));
    expect(onOpenBlock).toHaveBeenCalledWith('faq');

    fireEvent.change(screen.getByRole('textbox', { name: 'New task' }), { target: { value: 'Review pricing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Review pricing')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Details for Write the FAQ' }));
    expect(screen.getByText('Half done')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Assign to me' }));
    await waitFor(() => expect(requests.some(request => request.path === '/api/canvases/planning/tasks/t1/claim' && request.method === 'POST')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Mark Write the FAQ done' }));
    await waitFor(() => expect(requests.some(request => request.method === 'PUT' && (request.body as { status?: string })?.status === 'done')).toBe(true));
  });

  it('shows Jev task scores and applies a reviewed document suggestion', async () => {
    render(<TasksPanel canvas={canvas} visible onOpenBlock={() => undefined}/>);
    await screen.findByText('Write the FAQ');
    fireEvent.click(screen.getByRole('button', { name: 'Analyze tasks with Jev' }));
    expect(await screen.findByText('Priority 90% · Effort 20%')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort tasks' }), { target: { value: 'priority_effort' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(requests.some(request => request.path === '/api/canvases/planning/tasks/t1'
      && request.method === 'PUT' && JSON.stringify(request.body) === JSON.stringify({ blockIds: ['faq'] }))).toBe(true));
  });
});
