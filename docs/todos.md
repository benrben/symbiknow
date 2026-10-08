# Canvas tasks

Open a canvas and choose **Tasks** in the toolbar. Tasks belong to that canvas, alongside its documents. Switch between a list and a status board, search by task text, and sort by priority, due date, relative size, or newest. The task view can be linked with `?canvas=CANVAS_ID&view=todos`.

Tasks have a title, description, assignee, priority, optional due date, and relative size (XS, S, M, L, XL). Active statuses are **To do**, **In progress**, and **Blocked**. Marking work **Done** automatically moves it to **Archive**. Restore an archived task to return it to **To do**. Archived tasks retain their details and history.

The browser refreshes tasks created or updated by agents. Failed saves keep the draft visible for retry. Revision checks prevent an older edit from overwriting a newer one; refresh the task before retrying a conflict.

## MCP tools

| Tool | Use |
| --- | --- |
| `list_todos` | Read tasks in a canvas, including archived tasks. |
| `create_todo` | Add a task with title and optional planning fields. |
| `update_todo` | Edit task fields using its latest `expectedRevision`. |
| `set_todo_status` | Change status using its latest `expectedRevision`; `done` archives, `todo` reopens. |

All tools require `canvasId`. Updates require `taskId` and `expectedRevision` from the most recent read. Priorities are `low`, `normal`, `high`, and `urgent`; sizes are `xs`, `s`, `m`, `l`, and `xl`. Statuses are `todo`, `in_progress`, `blocked`, and `done`. Due dates use `YYYY-MM-DD`. `update_todo` accepts `dueDate: null` and `assignee: null` to clear those fields.

Read-only MCP tokens can list tasks. Writes require write access, and each tool respects the token's allowed canvases and tool list. Task changes are attributed to the agent or browser and saved through the existing task audit journal.

## HTTP API

| Method | Endpoint | Result |
| --- | --- | --- |
| GET | `/api/canvases/:canvasId/todos` | All saved tasks as an array. |
| POST | `/api/canvases/:canvasId/todos` | Create a task; returns the saved task with revision (201). |
| PUT | `/api/canvases/:canvasId/todos/:taskId` | Update using `expectedRevision`; returns the saved task (200). |

These endpoints use the normal workspace authentication. Invalid input returns 400, missing canvases or tasks return 404, and stale revisions return 409. A task with `status: "done"` is archived; no separate archive mutation is required. The old `/tasks` API remains retired.
