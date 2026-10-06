// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CanvasTask } from '../shared/types';
import { CanvasStore } from '../server/storage';
import { createProjectMcpServer } from '../server/mcp';
import { App } from './App';
import { assistantFixture } from './AppAssistantPanel.test.helpers';
import { installWorkspaceBrowser } from './AppWorkspaceView.test.helpers';
import { orderedTasks } from './TasksCanvasBoard';

installWorkspaceBrowser();

async function board() {
  await userEvent.click(screen.getByRole('button', { name: 'Open Tasks page' }));
  return screen.findByRole('region', { name: 'Tasks canvas board' });
}

describe('Tasks canvas board with native task persistence', () => {
  it('renders all four empty columns and saves creation and accessible status changes on real task records', async () => {
    const fixture = await assistantFixture(undefined, false);
    const surface = await board();
    expect([...surface.querySelectorAll('[data-task-column]')].map(node => node.getAttribute('data-task-column')))
      .toEqual(['todo', 'in_progress', 'blocked', 'done']);
    expect(within(surface).getByRole('button', { name: 'Create first task' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add task' })).toHaveLength(1);
    expect(document.querySelector('.task-canvas-create-nav')).toBeNull();
    expect(document.querySelector('.react-flow__minimap')).toBeNull();
    fireEvent.click(within(surface).getByRole('button', { name: 'Add task in Blocked' }));
    const form = document.querySelector<HTMLFormElement>('.task-canvas-create');
    expect(form).toBeTruthy();
    expect((within(form!).getByLabelText('Status') as HTMLSelectElement).value).toBe('blocked');
    expect(document.activeElement).toBe(within(form!).getByLabelText('Title'));
    fireEvent.change(within(form!).getByLabelText('Title'), { target: { value: 'Restore release' } });
    fireEvent.click(within(form!).getByRole('button', { name: 'Create task' }));
    await within(surface).findByRole('button', { name: 'Open task Restore release' });
    let tasks = await new CanvasStore(fixture.root).listTasks('product-roadmap');
    expect(tasks).toMatchObject([{ title: 'Restore release', status: 'blocked' }]);
    fireEvent.click(within(surface).getByRole('button', { name: 'Open task Restore release' }));
    const status = screen.getByRole('combobox', { name: 'Task status' });
    await userEvent.selectOptions(status, 'done');
    await waitFor(async () => {
      tasks = await new CanvasStore(fixture.root).listTasks('product-roadmap');
      expect(tasks[0].status).toBe('done');
    });
    await waitFor(() => expect(within(surface).getByRole('button', { name: 'Open task Restore release' })
      .closest('.react-flow__node')?.getAttribute('style')).toContain('1116px'));
    fixture.unmount();
    const { render } = await import('@testing-library/react');
    render(<App/>);
    expect(await screen.findByRole('region', { name: 'Tasks canvas board' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Open task Restore release' })).toBeTruthy();
  });

  it('lets the global task action choose a status and restores Tasks through the URL', async () => {
    const fixture = await assistantFixture(undefined, false);
    await board();
    expect(window.location.search).toContain('view=tasks');
    const push = vi.spyOn(window.history, 'pushState');
    fireEvent.click(screen.getByRole('button', { name: 'Open Tasks page' }));
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: /^Add task$/ }));
    const form = screen.getByRole('dialog', { name: 'Create task' });
    expect((within(form).getByLabelText('Status') as HTMLSelectElement).value).toBe('todo');
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Check launch' } });
    fireEvent.change(within(form).getByLabelText('Status'), { target: { value: 'in_progress' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create task' }));
    await screen.findByRole('button', { name: 'Open task Check launch' });
    expect((await new CanvasStore(fixture.root).listTasks('product-roadmap'))[0].status).toBe('in_progress');
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Product Roadmap' }));
    await screen.findByText('Product Roadmap', { selector: '.canvas-label h1' });
    expect(window.location.search).not.toContain('view=tasks');
    act(() => window.history.back());
    expect(await screen.findByRole('region', { name: 'Tasks canvas board' })).toBeTruthy();
    act(() => window.history.forward());
    expect(await screen.findByText('Product Roadmap', { selector: '.canvas-label h1' })).toBeTruthy();
    act(() => window.history.back());
    expect(await screen.findByRole('region', { name: 'Tasks canvas board' })).toBeTruthy();
    fixture.unmount();
    const { render } = await import('@testing-library/react');
    render(<App/>);
    expect(await screen.findByRole('region', { name: 'Tasks canvas board' })).toBeTruthy();
  });

  it('reflects an external task update and rolls back a rejected board save', async () => {
    let rejectStatus = false;
    const fixture = await assistantFixture((route, init, forward) => {
      if (rejectStatus && init.method === 'PUT' && /\/tasks\//.test(route)) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Task revision conflict' }), { status: 409, headers: { 'content-type': 'application/json' } }));
      }
      return forward();
    }, false, async request => {
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'External task', status: 'todo' }) });
    });
    const surface = await board();
    const store = new CanvasStore(fixture.root);
    const [task] = await store.listTasks('product-roadmap');
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      return fixture.request(url.pathname + url.search, init);
    }) as typeof fetch;
    const mcp = createProjectMcpServer('http://127.0.0.1:8787/api', fetcher, { access: 'write' });
    const client = new Client({ name: 'board-test-agent', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
    try {
      const response = await client.callTool({ name: 'update_task', arguments: {
        canvasId: 'product-roadmap', taskId: task.id, status: 'in_progress', expectedRevision: task.revision,
      } });
      expect(response.isError).not.toBe(true);
    } finally { await client.close(); await mcp.close(); }
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open task External task' }).closest('.react-flow__node')?.getAttribute('style'))
      .toContain('384px'), { timeout: 5000 });
    rejectStatus = true;
    fireEvent.click(within(surface).getByRole('button', { name: 'Open task External task' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Task status' }), 'done');
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('Task revision conflict');
    expect((await store.listTasks('product-roadmap'))[0].status).toBe('in_progress');
    expect(screen.getByRole('button', { name: 'Open task External task' }).closest('.react-flow__node')?.getAttribute('style'))
      .toContain('384px');
  });

  it('orders many tasks by saved board order without changing their status or document positions', () => {
    const seed = (id: string, status: CanvasTask['status'], boardOrder: number): CanvasTask => ({
      id, title: id, detail: '', status, boardOrder, blockIds: [], createdBy: 'Fixture', updatedBy: 'Fixture',
      createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z', comments: [],
    });
    const tasks = [seed('c', 'todo', 3000), seed('a', 'todo', 1000), seed('b', 'todo', 2000), seed('done', 'done', 0)];
    expect(orderedTasks(tasks, 'todo').map(task => task.id)).toEqual(['a', 'b', 'c']);
    expect(orderedTasks(tasks, 'done').map(task => task.id)).toEqual(['done']);
    expect(tasks.map(task => task.status)).toEqual(['todo', 'todo', 'todo', 'done']);
    const unordered = [seed('z', 'todo', 0), seed('b', 'todo', 0), seed('a', 'todo', 0)];
    unordered[0].boardOrder = undefined;
    unordered[1].createdAt = '2026-10-05T00:00:00.000Z';
    expect(orderedTasks(unordered, 'todo').map(task => task.id)).toEqual(['b', 'a', 'z']);
    unordered[0].boardOrder = 0;
    expect(orderedTasks(unordered, 'todo').map(task => task.id)).toEqual(['b', 'a', 'z']);
    unordered[1].boardOrder = undefined;
    unordered[2].boardOrder = undefined;
    expect(orderedTasks(unordered, 'todo').map(task => task.id)).toEqual(['z', 'b', 'a']);
  });

  it('adds a task after an existing card without changing that card or its saved order', async () => {
    const fixture = await assistantFixture(undefined, false, async request => {
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Existing task', status: 'todo', boardOrder: 2000 }) });
    });
    const surface = await board();
    fireEvent.click(within(surface).getByRole('button', { name: 'Add task in To do' }));
    const form = document.querySelector<HTMLFormElement>('.task-canvas-create')!;
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'New task' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create task' }));
    await within(surface).findByRole('button', { name: 'Open task New task' });
    expect((await new CanvasStore(fixture.root).listTasks('product-roadmap')).map(task =>
      ({ title: task.title, boardOrder: task.boardOrder }))).toEqual([
      { title: 'Existing task', boardOrder: 2000 }, { title: 'New task', boardOrder: 3000 },
    ]);
  });

  it('recovers a transient task-list read error and shows the saved board on the next poll', async () => {
    let failOnce = true;
    await assistantFixture((route, init, forward) => {
      if (failOnce && (!init.method || init.method === 'GET') && /\/canvases\/product-roadmap\/tasks$/.test(route)) {
        failOnce = false;
        return Promise.resolve(Response.json({ error: 'Tasks temporarily unavailable' }, { status: 503 }));
      }
      return forward();
    }, false, async request => {
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Persisted task', status: 'blocked' }) });
    });
    const surface = await board();
    expect((await screen.findByRole('alert')).textContent).toContain('Tasks temporarily unavailable');
    expect(await within(surface).findByRole('button', { name: 'Open task Persisted task' }, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  }, 7000);

  it.each([
    ['an empty response', () => Response.json([])],
    ['a failed response', () => Response.json({ error: 'Old read failed' }, { status: 503 })],
  ])('keeps a newly saved card when an older task-list request finishes with %s', async (_case, oldResponse) => {
    let releaseOldRead: ((response: Response) => void) | undefined;
    let reads = 0;
    const fixture = await assistantFixture((route, init, forward) => {
      if ((!init.method || init.method === 'GET') && /\/canvases\/product-roadmap\/tasks$/.test(route)) {
        reads += 1;
        if (reads === 1) return new Promise<Response>(resolve => { releaseOldRead = resolve; });
      }
      return forward();
    }, false);
    const surface = await board();
    fireEvent.click(screen.getByRole('button', { name: /^Add task$/ }));
    const form = document.querySelector<HTMLFormElement>('.task-canvas-create')!;
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Saved during loading' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create task' }));
    await within(surface).findByRole('button', { name: 'Open task Saved during loading' });
    expect(reads).toBeGreaterThanOrEqual(2);
    await act(async () => { releaseOldRead!(oldResponse()); });
    expect(within(surface).getByRole('button', { name: 'Open task Saved during loading' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect((await new CanvasStore(fixture.root).listTasks('product-roadmap'))[0].title).toBe('Saved during loading');
  });

  it('opens a linked source document from task details through the ordinary reader', async () => {
    const fixture = await assistantFixture(undefined, false, async request => {
      const canvas = await request('/api/canvases/product-roadmap').then(response => response.json());
      const block = canvas.blocks[0];
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Read source', blockIds: [block.id] }) });
    });
    await board();
    fireEvent.click(await screen.findByRole('button', { name: 'Open task Read source' }));
    const details = screen.getByRole('complementary', { name: 'Task details' });
    const document = (await fixture.read('product-roadmap')).blocks[0];
    fireEvent.click(within(details).getByRole('button', { name: document.title }));
    expect(await screen.findByRole('dialog', { name: `${document.title} full page` })).toBeTruthy();
  });

  it('shows durable task history and undoes a guarded status change', async () => {
    const fixture = await assistantFixture(undefined, false, async request => {
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Review release', status: 'todo' }) });
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Independent review', status: 'blocked' }) });
    });
    const surface = await board();
    fireEvent.click(await within(surface).findByRole('button', { name: 'Open task Review release' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Task status' }), 'done');
    const store = new CanvasStore(fixture.root);
    await waitFor(async () => expect((await store.listTasks('product-roadmap'))[0].status).toBe('done'));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Task status' }) as HTMLSelectElement).value).toBe('done'));
    fireEvent.click(screen.getByText(/History ·/));
    const history = await fixture.request(`/api/canvases/product-roadmap/tasks/${(await store.listTasks('product-roadmap'))[0].id}/history?limit=25`)
      .then(response => response.json()) as { items: Array<{ eventId: string; kind: string }> };
    const latest = history.items[0];
    expect(latest.kind).toBe('updated');
    const undo = await screen.findAllByRole('button', { name: 'Undo this change' });
    expect(document.querySelector('.task-canvas-history')?.textContent).toContain('todo → done');
    expect(undo).toHaveLength(2);
    const row = document.querySelector<HTMLElement>(`[data-task-event-id="${latest.eventId}"]`);
    expect(row).toBeTruthy();
    fireEvent.click(within(row!).getByRole('button', { name: 'Undo this change' }));
    await waitFor(async () => expect({ status: (await store.listTasks('product-roadmap'))[0].status,
      error: screen.queryByRole('alert')?.textContent ?? null }).toEqual({ status: 'todo', error: null }));
    await waitFor(() => expect(within(surface).getByRole('button', { name: 'Open task Review release' })
      .closest('.react-flow__node')?.getAttribute('style')).toContain('18px'));
    expect(within(surface).getByRole('button', { name: 'Open task Independent review' })).toBeTruthy();
  });

  it('removes a created task from the board when its creation is undone', async () => {
    const fixture = await assistantFixture(undefined, false, async request => {
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Temporary task', status: 'todo' }) });
    });
    const surface = await board();
    fireEvent.click(await within(surface).findByRole('button', { name: 'Open task Temporary task' }));
    fireEvent.click(screen.getByText(/History ·/));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo this change' }));
    await waitFor(() => expect(within(surface).queryByRole('button', { name: 'Open task Temporary task' })).toBeNull());
    expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull();
    expect(await new CanvasStore(fixture.root).listTasks('product-roadmap')).toHaveLength(0);
  });

  it('shows a history read failure without hiding the task or its status control', async () => {
    await assistantFixture((route, _init, forward) => {
      if (/\/tasks\/[^/]+\/history\?/.test(route)) return Promise.resolve(Response.json({ error: 'History temporarily unavailable' }, { status: 503 }));
      return forward();
    }, false, async request => {
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Review release', status: 'todo' }) });
    });
    const surface = await board();
    fireEvent.click(await within(surface).findByRole('button', { name: 'Open task Review release' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'History temporarily unavailable');
    expect((screen.getByRole('combobox', { name: 'Task status' }) as HTMLSelectElement).value).toBe('todo');
    expect(within(surface).getByRole('button', { name: 'Open task Review release' })).toBeTruthy();
  });

  it.each([
    ['successful', () => Response.json({ items: [] })],
    ['failed', () => Response.json({ error: 'Old history failure' }, { status: 503 })],
  ])('ignores a %s history response after task details are closed', async (_case, oldResponse) => {
    let releaseHistory: ((response: Response) => void) | undefined;
    await assistantFixture((route, _init, forward) => {
      if (/\/tasks\/[^/]+\/history\?/.test(route)) {
        return new Promise<Response>(resolve => { releaseHistory = resolve; });
      }
      return forward();
    }, false, async request => {
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Inspect history', status: 'todo' }) });
    });
    const surface = await board();
    fireEvent.click(await within(surface).findByRole('button', { name: 'Open task Inspect history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close task details' }));
    await act(async () => { releaseHistory!(oldResponse()); });
    expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps an unsaved comment available to retry after the save fails', async () => {
    await assistantFixture((route, init, forward) => {
      if (init.method === 'POST' && /\/tasks\/[^/]+\/comments$/.test(route)) {
        return Promise.resolve(Response.json({ error: 'Comment could not be saved' }, { status: 503 }));
      }
      return forward();
    }, false, async request => {
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Review release', status: 'todo' }) });
    });
    const surface = await board();
    fireEvent.click(await within(surface).findByRole('button', { name: 'Open task Review release' }));
    const details = screen.getByRole('complementary', { name: 'Task details' });
    const input = within(details).getByLabelText('Add a comment') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Keep this note' } });
    fireEvent.click(within(details).getByRole('button', { name: 'Add comment' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Comment could not be saved');
    expect(input.value).toBe('Keep this note');
  });

  it('shows a saved comment and clears its input only after the server commits it', async () => {
    const fixture = await assistantFixture(undefined, false, async request => {
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Review release', status: 'todo' }) });
      await request('/api/canvases/product-roadmap/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Independent task', status: 'blocked' }) });
    });
    const surface = await board();
    fireEvent.click(await within(surface).findByRole('button', { name: 'Open task Review release' }));
    const details = screen.getByRole('complementary', { name: 'Task details' });
    const input = within(details).getByLabelText('Add a comment') as HTMLTextAreaElement;
    fireEvent.submit(details.querySelector('form')!);
    expect((await new CanvasStore(fixture.root).listTasks('product-roadmap'))[0].comments).toHaveLength(0);
    fireEvent.change(input, { target: { value: 'Approved after review' } });
    fireEvent.click(within(details).getByRole('button', { name: 'Add comment' }));
    expect(await within(details).findByText('Approved after review')).toBeTruthy();
    await waitFor(() => expect(input.value).toBe(''));
    expect((await new CanvasStore(fixture.root).listTasks('product-roadmap'))[0].comments)
      .toMatchObject([{ text: 'Approved after review' }]);
    expect(screen.getByRole('button', { name: 'Open task Independent task' })).toBeTruthy();
  });

  it('renders many saved tasks once in their persisted columns and order after reload', async () => {
    const fixture = await assistantFixture(undefined, false, async (_request, root) => {
      const store = new CanvasStore(root);
      for (let index = 0; index < 28; index += 1) {
        const status: CanvasTask['status'] = ['todo', 'in_progress', 'blocked', 'done'][index % 4] as CanvasTask['status'];
        await store.createTask('product-roadmap', { title: `Board item ${index}`, status, boardOrder: (28 - index) * 1000 }, 'Fixture');
      }
    });
    const surface = await board();
    const cards = await within(surface).findAllByRole('button', { name: /^Open task Board item/ });
    expect(cards).toHaveLength(28);
    expect(new Set(cards.map(card => card.getAttribute('data-task-id'))).size).toBe(28);
    const firstTodo = within(surface).getByRole('button', { name: 'Open task Board item 24' });
    const lastTodo = within(surface).getByRole('button', { name: 'Open task Board item 0' });
    const cardY = (card: HTMLElement) => Number.parseInt(card.closest('.react-flow__node')!.getAttribute('style')!
      .match(/translate\(\d+px,\s*(\d+)px\)/)![1], 10);
    expect(cardY(firstTodo)).toBeLessThan(cardY(lastTodo));
    fixture.unmount();
    const { render } = await import('@testing-library/react');
    render(<App/>);
    const reloaded = await screen.findByRole('region', { name: 'Tasks canvas board' });
    expect(await within(reloaded).findAllByRole('button', { name: /^Open task Board item/ })).toHaveLength(28);
  }, 15000);
});
