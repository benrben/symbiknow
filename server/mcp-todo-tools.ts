import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CanvasApi, canvasPath, result } from './mcp-api.js';

const canvasId = z.string().min(1).describe('Canvas ID from list_canvases');
const taskId = z.string().min(1).describe('Task ID from list_todos or create_todo');
const title = z.string().trim().min(1).max(160);
const detail = z.string().max(4000);
const priority = z.enum(['low', 'normal', 'high', 'urgent']);
const size = z.enum(['xs', 's', 'm', 'l', 'xl']).describe('Estimated task size, from extra small to extra large');
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Calendar due date in YYYY-MM-DD format');
const assignee = z.string().max(48);
const status = z.enum(['todo', 'in_progress', 'blocked', 'done'])
  .describe('done automatically moves the task to Archive. Set todo to reopen it.');
const expectedRevision = z.number().int().min(0)
  .describe('Current revision from list_todos or a saved task. A stale revision fails without overwriting another edit.');

export function registerTodoTools(registration: McpServer, api: CanvasApi): void {
  registration.registerTool('list_todos', { _meta: { apiRoutes: [{"method":"GET","path":"/canvases/:canvasId/todos"}] },
    annotations: { readOnlyHint: true },
    description: 'List tasks for one canvas, including archived tasks whose status is done. Returns revisions for safe updates.',
    inputSchema: { canvasId },
  }, async ({ canvasId: id }) => result(await api.request(canvasPath(id) + '/todos')));
  registration.registerTool('create_todo', { _meta: { apiRoutes: [{"method":"POST","path":"/canvases/:canvasId/todos","bodyFields":["title","detail","priority","size","dueDate","assignee","status"]}] },
    description: 'Create a task on a canvas with priority, due date, estimated size, and assignee. Tasks marked done are automatically archived.',
    inputSchema: { canvasId, title, detail: detail.optional(), priority: priority.optional(), size: size.optional(),
      dueDate: dueDate.optional(), assignee: assignee.optional(), status: status.optional() },
  }, async ({ canvasId: id, ...input }) => result(await api.request(canvasPath(id) + '/todos', 'POST', input)));
  registration.registerTool('update_todo', { _meta: { apiRoutes: [{"method":"PUT","path":"/canvases/:canvasId/todos/:taskId","bodyFields":["expectedRevision","title","detail","priority","size","dueDate","assignee","status"]}] },
    description: 'Edit a task using its current revision. Set dueDate or assignee to null to clear it. Setting status to done archives it automatically.',
    inputSchema: { canvasId, taskId, expectedRevision, title: title.optional(), detail: detail.optional(),
      priority: priority.optional(), size: size.optional(), dueDate: dueDate.nullable().optional(),
      assignee: assignee.nullable().optional(), status: status.optional() },
  }, async ({ canvasId: id, taskId: idOfTask, ...patch }) => result(await api.request(
    `${canvasPath(id)}/todos/${encodeURIComponent(idOfTask)}`, 'PUT', patch)));
  registration.registerTool('set_todo_status', { _meta: { apiRoutes: [{"method":"PUT","path":"/canvases/:canvasId/todos/:taskId","bodyFields":["expectedRevision","status"]}] },
    description: 'Change a task status using its current revision. done automatically archives the task; todo reopens an archived task.',
    inputSchema: { canvasId, taskId, expectedRevision, status },
  }, async ({ canvasId: id, taskId: idOfTask, ...patch }) => result(await api.request(
    `${canvasPath(id)}/todos/${encodeURIComponent(idOfTask)}`, 'PUT', patch)));
}
