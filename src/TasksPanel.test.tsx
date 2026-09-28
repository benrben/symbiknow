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
      tasks.push(task({ id: 't3', title: String(body?.title), detail: String(body?.detail ?? ''), createdBy: 'Browser',
        assignee: typeof body?.assignee === 'string' ? body.assignee : undefined,
        blockIds: Array.isArray(body?.blockIds) ? body.blockIds as string[] : [],
        findingRef: body?.findingRef as CanvasTask['findingRef'] }));
      return Response.json(tasks.at(-1), { status: 201 });
    }
    if (path === '/api/canvases/planning/tasks/insights') return Response.json({
      scores: { t1: { priority: 0.9, effort: 0.2, blocked: 0.1, priorityPerEffort: 4.5 } },
      items: [{ id: 'task-attach-t1', category: 'task', title: 'Attach Launch FAQ to Write the FAQ',
        detail: 'Relevant document', blockIds: ['faq'], confidence: 0.8,
        proposedAction: { type: 'task', taskId: 't1', patch: { blockIds: ['faq'] } } }],
    });
    const match = path.match(/\/tasks\/(t\d)(?:\/(claim|comments))?$/);
    if (match && method === 'DELETE') tasks = tasks.filter(item => item.id !== match[1]);
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


  it('requires confirmation before deleting a task with comments, assignee, or linked documents', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TasksPanel canvas={canvas} visible onOpenBlock={() => undefined}/>);
    await screen.findByText('Write the FAQ');
    fireEvent.click(screen.getByRole('button', { name: 'Details for Write the FAQ' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Write the FAQ' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('cannot be recovered'));
    expect(requests.some(request => request.method === 'DELETE')).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Write the FAQ' }));
    await waitFor(() => expect(requests.some(request => request.method === 'DELETE')).toBe(true));
  });

  it('creates an evidence-backed task from a finding and preserves its return path', async () => {
    const onFindingTaskCreated = vi.fn();
    const onOpenFinding = vi.fn();
    const onOpenInvestigation = vi.fn();
    const findingRef = { id: 'finding-1', title: 'Clarify the launch policy', canvasId: 'planning', blockIds: ['faq'],
      detail: 'The FAQ does not explain the launch exception.',
      evidence: [{ questionId: 'q-1', answer: 'No exception listed', excerpt: 'The launch rules omit the exception.', sourceIds: ['faq'] }],
      suggestedOwner: 'Morgan', investigationId: 'investigation-7' };
    const panel = render(<TasksPanel canvas={canvas} visible onOpenBlock={() => undefined} findingRef={findingRef}
      onFindingTaskCreated={onFindingTaskCreated} onOpenFinding={onOpenFinding} onOpenInvestigation={onOpenInvestigation}/>);
    const input = await screen.findByRole('textbox', { name: 'New task' });
    expect(input).toHaveProperty('value', 'Clarify the launch policy');
    expect(screen.getByText('Affected documents:').parentElement?.textContent).toContain('Launch FAQ');
    expect(screen.getByRole('textbox', { name: 'Suggested owner' })).toHaveProperty('value', 'Morgan');
    const investigationChoice = screen.getByRole('checkbox', { name: 'Link this task to the open saved investigation' });
    expect(investigationChoice).toHaveProperty('checked', false);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved investigation' }));
    expect(onOpenInvestigation).toHaveBeenCalledWith('investigation-7');
    fireEvent.click(investigationChoice);
    fireEvent.click(screen.getByRole('button', { name: 'Return to finding in Insights' }));
    expect(onOpenFinding).toHaveBeenCalledWith(findingRef);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onFindingTaskCreated).toHaveBeenCalledOnce());
    expect(onFindingTaskCreated).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Clarify the launch policy', findingRef: expect.objectContaining({ investigationId: 'investigation-7' }),
    }));
    const created = requests.find(request => request.method === 'POST')?.body as Record<string, unknown>;
    expect(created).toMatchObject({ title: 'Clarify the launch policy', assignee: 'Morgan', blockIds: ['faq'],
      detail: expect.stringContaining('The launch rules omit the exception.'),
      findingRef: { id: 'finding-1', canvasId: 'planning', blockIds: ['faq'], suggestedOwner: 'Morgan', investigationId: 'investigation-7',
        detail: 'The FAQ does not explain the launch exception.', evidence: [{ excerpt: 'The launch rules omit the exception.' }] } });
    await screen.findByText('From finding');
    expect(screen.getAllByText('The launch rules omit the exception.')).toHaveLength(2);
    expect(screen.getAllByText('Affected documents:').at(-1)?.parentElement?.textContent).toContain('Launch FAQ');
    fireEvent.click(screen.getAllByRole('button', { name: 'Open saved investigation' }).at(-1)!);
    expect(onOpenInvestigation).toHaveBeenCalledTimes(2);
    expect(onOpenInvestigation).toHaveBeenLastCalledWith('investigation-7');
    fireEvent.click(screen.getByRole('button', { name: 'Open finding in Insights' }));
    expect(onOpenFinding).toHaveBeenLastCalledWith(findingRef);
    panel.rerender(<TasksPanel canvas={canvas} visible onOpenBlock={() => undefined}/>);
    fireEvent.change(screen.getByRole('textbox', { name: 'New task' }), { target: { value: 'Ordinary task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(requests.filter(request => request.method === 'POST')).toHaveLength(2));
    expect(requests.filter(request => request.method === 'POST').at(-1)?.body).toEqual({ title: 'Ordinary task' });
  });

  it('does not attach an available saved investigation unless the user opts in', async () => {
    const findingRef = { id: 'finding-2', title: 'Review retention', canvasId: 'planning', blockIds: ['faq'],
      investigationId: 'investigation-8' };
    render(<TasksPanel canvas={canvas} visible onOpenBlock={() => undefined} findingRef={findingRef}/>);
    const choice = await screen.findByRole('checkbox', { name: 'Link this task to the open saved investigation' });
    expect(choice).toHaveProperty('checked', false);
    fireEvent.change(screen.getByRole('textbox', { name: 'New task' }), { target: { value: 'Review retention' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(requests.some(request => request.method === 'POST')).toBe(true));
    const created = requests.find(request => request.method === 'POST')?.body as Record<string, unknown>;
    expect(created.findingRef).toEqual({ id: 'finding-2', title: 'Review retention', canvasId: 'planning', blockIds: ['faq'] });
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
