# Errors and status codes

This page lists the errors that SymbiKnow returns, what each status code means, and what a person or agent should do next.

All facts come from the code in `server/`, `src/`, and `shared/`. File names are given so you can check the current text. Messages that contain `${...}` are filled in at runtime.

## How errors are shaped

### The `ApiError` class

The server throws one error class, `ApiError(status, message, details?)`, from `server/errors.ts`. The request handler in `server/index.ts` (`respondError`) turns it into JSON:

```json
{ "error": "This document changed since you read it. Read it again and reapply your edit.",
  "currentContentHash": "…" }
```

- `status` becomes the HTTP status code.
- `message` becomes the `error` field.
- `details` are copied into the same object, next to `error`.
- Any other thrown error becomes `500` with `{ "error": "Internal server error" }`. The server logs the real error to the console. Only `500` responses are logged this way.
- If the client already closed the connection, no error response is written.
- A path under `/api/` or the app that matches no route returns `404 { "error": "Route not found" }`.

### Detail fields

Only a few errors add details today:

| Field | Sent by | Meaning |
| --- | --- | --- |
| `currentContentHash` | `checkExpectedHash` in `server/storage-validation.ts` (edits, uploads) and `checkDeletionPreconditions` in `server/document-deletion.ts` (deletes) | The hash of the document as it is now. Read the document again, merge, then retry. |

Branch edits put the current hash inside the message text instead: `This branch changed since you read it. Current contentHash: <hash>` (`server/storage-documents.ts`).

### Batch import results

`POST /api/canvases/:id/imports` (`server/api-documents.ts`, up to 20 documents) returns `200` even when some documents fail. Each item has its own result:

```json
{ "results": [ { "index": 0, "ok": true, "blockId": "…", "contentHash": "…", "revision": "…", "processing": "pending" },
               { "index": 1, "ok": false, "error": "idempotencyKey is required" },
               { "index": 2, "ok": false, "error": "…", "status": 409 } ] }
```

Check every item. `status` is present when the store threw an error for that item.

### MCP tool results

MCP tools call the HTTP API through `CanvasApi` in `server/mcp-api.ts`. A non-2xx response becomes an `ApiRequestError(status, currentContentHash, message)`. The message is the server's `error` text, or `Canvas API request failed (<status>)` if the body has none. If the API cannot be reached at all, the tool fails with `Canvas API is unavailable at <base URL>`.

`server/mcp-scope.ts` wraps every tool:

- A `409` becomes a structured tool result with `isError: true`:

  ```json
  { "error": "<server message>", "code": "conflict", "currentContentHash": "<hash or undefined>",
    "instruction": "Read the current source and merge before retrying." }
  ```

- Every other error is re-thrown. The MCP SDK then returns it as a tool result with `isError: true` and the message as text.
- A tool or canvas outside the token's scope fails with `This token scope does not permit that tool or canvas.` The call is recorded as `denied` in the MCP activity ledger. Other failures are recorded as `error`.

Some MCP tools check their input before they call the API, for example:

| Message | Source |
| --- | --- |
| `expectedContentHash from read_doc is required for edit_doc.` | `server/mcp-tools.ts` |
| `expectedContentHash from read_doc is required to replace a document.` | `server/mcp-files.ts` (`upload_file` with `blockId`) |
| `Provide content or sourcePath, not both.` / `Provide the complete file content.` | `server/mcp-files.ts` |
| `The file is too large for a canvas document.` | `server/mcp-files.ts` (local file over 999,900 bytes) |
| `Job not found in the granted scope` | `server/mcp-jev-tools.ts` |

### Remote MCP transport errors

The HTTP MCP endpoint (`/mcp` and `/mcp/t/<token>`) answers transport problems with a JSON-RPC error body, `{ "jsonrpc": "2.0", "error": { "code": -32000, "message": "…" }, "id": null }` (`server/mcp-http-protocol.ts`, `server/mcp-http.ts`):

| Status | Message | Next step |
| --- | --- | --- |
| 401 | `Missing or invalid MCP token. Create one in Settings → Connect agents.` (with `WWW-Authenticate: Bearer`) | Create or copy a valid MCP token. |
| 403 | `This MCP session belongs to another token.` | Start a new session with your own token. |
| 404 | `Session not found. Start a new MCP session.` | Send `initialize` again. |
| 400 | `Send an initialize request to start an MCP session.` | Send `initialize` first. |
| 400 | `Request body is too large` (over 4,000,000 bytes) or a JSON parse message | Send smaller, valid JSON. |

### Chat stream (SSE) errors

`POST` chat streaming (`server/chat-sse.ts`) has two cases:

- **Before the stream starts** (no headers sent yet): the error is a normal JSON error response with a status code.
- **After the stream starts**: the server writes one SSE event and stops:

  ```
  event: error
  data: {"message":"<ApiError message, or: Chat stream stopped. Check the model settings.>"}
  ```

The browser parser (`src/chat-sse-parser.ts`) throws on this event. If `message` is empty it shows `The assistant stopped. Please retry.` A completion chunk with an `error` field is also treated as a failure.

### Browser handling

`src/api.ts` (`requestFailure`) and `src/chatStream.ts` read errors the same way:

- `401` (except on `/session`) fires the `symbiknow:auth-required` event, so the app asks for the access token again.
- If the body has `error`, that text is shown.
- `502`, `503`, or `504` with no `error` text shows `Canvas server is unavailable or restarting (<status>). Retry in a moment.`
- Otherwise: `Request failed (<status>)`.
- If `fetch` itself fails: `Canvas server is unavailable. Check that it is running, then retry.`

For chat requests that fail before streaming, `src/chatStream.ts` shows the `error` text or `Canvas chat request failed (<status>). Retry in a moment.`

Form fields are checked in the browser before any request. `src/ValidationMessage.tsx` replaces the native browser bubble with one app-styled message, for example `<Field> is required.` `src/app-dialog-errors.ts` decides which dialogs (`block`, `canvas`, `workspace`, `delete-canvas`, `delete-workspace`) show the server error inside the dialog.

## Status codes

The server uses these codes: 400, 401, 403, 404, 405, 409, 410, 413, 415, 423, 429, 499, 500, 502, 503. Codes 402 and 504 appear only as upstream provider statuses (see [Provider and Jev errors](#provider-and-jev-errors)).

Rough counts of `new ApiError(` in non-test server code: 400 (about 220), 409 (about 110), 404 (65), 503 (55), 502 (43), 403 (29), 500 (9), 499 (7), 410 (6), 401 (4), 413 (3), 429 (2), 405, 415, and 423 (1 each).

### 400 Bad Request: the input is not valid

The request was understood but a value is wrong. The message names the field. Fix the input and send again. Retrying the same request will fail the same way.

| Message (examples) | Source | When |
| --- | --- | --- |
| `Expected a JSON object` | `server/api-http.ts` | Body is not a JSON object. |
| `Invalid canvas ID` / `Invalid block ID` / `Invalid workspace ID` | `server/storage.ts`, `server/storage-documents.ts` | An ID has characters that are not allowed. |
| `content must be a string of at most 1 MB` | `server/storage-validation.ts` | Document content too long. |
| `<field> must be a nonempty string of at most <n> characters` | `server/storage-validation.ts`, `server/coordination-values.ts`, `server/settings.ts` | Title, note, name, and similar text fields. |
| `<field> must be a finite number within 1,000,000` / `<field> must be between 100 and 5000` | `server/storage-validation.ts` | Position or size out of range. |
| `Unsupported block kind` | `server/storage-validation.ts` | Unknown `kind`. |
| `tags must be an array of at most 20 nonempty labels, each at most 40 characters` | `server/storage-validation.ts` | Bad tags. |
| `group must be a lane:, area:, purpose:, or custom: key …` | `server/storage-validation.ts` | Bad group key. |
| `links must contain existing block IDs on this canvas` | `server/storage-validation.ts`, `server/storage-documents.ts` | A link points to a missing document. |
| `crossLinks must contain at most 20 links` / `Invalid cross link` | `server/storage-validation.ts` | Bad cross-canvas links. |
| `Cross links must target existing documents in this workspace` | `server/storage-documents.ts` | Cross-link target missing. |
| `idempotencyKey must be a nonempty string of at most 128 characters` | `server/storage-documents.ts` | Bad idempotency key on create. |
| `Documents can move only within one workspace` / `Choose another canvas in this workspace` | `server/storage-documents.ts` | Move to the same canvas or another workspace. |
| `A branch edit changes only source content` | `server/storage-documents.ts` | Branch edit with fields other than `content`, `expectedContentHash`, `message`. |
| `Invalid branch name` / `Invalid revision ID` | `server/version-reference.ts` | Bad version reference. |
| `Choose another branch to merge` | `server/version-control.ts` | Merging the current branch into itself. |
| `ttlSeconds must be between 30 and 3600` | `server/coordination.ts` | Lock lease length out of range. |
| `status must be todo, in_progress, blocked, or done` / `Invalid task status` | `server/coordination-values.ts`, `server/api-tasks.ts` | Bad task status. |
| `dueDate must be a valid YYYY-MM-DD date` | `server/coordination-values.ts` | Bad due date. |
| `A canvas can hold at most 500 tasks` / `Task dependencies cannot form a cycle` | `server/storage-tasks.ts` | Task board limits. |
| `Undo requires eventId and expectedRevision` / `Invalid expectedRevision` | `server/api-tasks.ts` | Task undo or delete input. |
| `Search query is too long` | `server/storage.ts` | Query over 200 characters. |
| `Chat message is too long` / `messages must contain 1 to 100 messages` / `The last chat message must be from the user` | `server/chat-input.ts` | Bad chat request (message limit is 20,000 characters). |
| `Select at least one proposed change` / `Unknown or duplicate change ID` / `This proposal has no changes that can be safely applied` | `server/chat-proposals.ts` | Applying a Chat proposal. |
| `Choose a <provider> model in Settings before using chat` / `Set a <provider> API key in Settings before using chat` / `Set a base URL for the OpenAI-compatible provider in Settings` | `server/providers.ts`, `server/chat-agent-configuration.ts` | Chat is not configured. |
| `Unknown model provider` / `Unknown provider <name>` | `server/providers.ts`, `server/settings.ts` | Bad provider name. |
| `Secret <name> is not saved` | `server/settings.ts`, `server/api-connection-server.ts` | A header or connection refers to a missing secret. |
| `Enter an http or https MCP server URL` | `server/api-connection-server.ts` | Bad external MCP URL. |
| `access must be read, propose, or write` / `The selected tools exceed this token access level` | `server/settings.ts` | Creating an MCP token. |
| `Invalid related request` / `Invalid ask_symbi request` / `Invalid symbi_reflex request` / `Invalid ask_symbi cursor` | `server/api-symbi.ts` | Brain tool input. |
| `Invalid or oversized Symbi Reflex …` | `server/jev-api-input.ts` | Reflex input over 24,000 characters or invalid. |
| `Unknown Symbi Reflex action` | `server/jev/actions.ts`, `server/jev/runtime-queue.ts` | Bad Reflex action name. |
| `Use generator: mkdocs, hugo, or docusaurus` / `Website source must stay inside the data directory` | `server/website.ts` | Website block settings. |

### 401 Unauthorized: sign in again

| Message | Source | When | Next step |
| --- | --- | --- | --- |
| `Sign in with the workspace access token` | `server/index.ts`, `server/jev-api-principal.ts` | An `/api/` request has no valid token or session cookie, and a workspace token is set. | Sign in, or send `Authorization: Bearer <token>`. |
| `That access token is not correct` | `server/api-access.ts` | `POST /api/session` with a wrong token. | Check the token value. |
| `The agent token is no longer authorized` | `server/jev-api-principal.ts` | A bearer token on a Reflex route matches no current access token. | Use the current token. |

The session cookie is an HMAC of the access token (`server/auth.ts`). If you change `SYMBIKNOW_ACCESS_TOKEN` (or the legacy `ALLTEAM_ACCESS_TOKEN`), old browser sessions stop working and get `401`. Both variables can be set at the same time during a migration.

### 403 Forbidden: you are known, but not allowed

| Message | Source | When | Next step |
| --- | --- | --- | --- |
| `Requests from sandboxed documents are not allowed` | `server/index.ts` | A non-GET/HEAD request with `Origin: null` (from a sandboxed HTML document). | Do not change data from inside sandboxed HTML. Use the app. |
| `A reviewed draft is active. Resume, rebase, or cancel it before writing this source.` | `server/jev-agent-write-guard.ts` | An MCP or internal write (PUT/DELETE a block, or switch/merge/restore) while a Reflex draft is open for that document. | Finish or cancel the draft first. |
| `This token does not permit that canvas` / `…that read tool` / `…that brain tool` | `server/jev-canvas-projection.ts`, `server/jev-api-handlers.ts`, `server/api-symbi.ts` | Token scope is too narrow. | Use a token with that canvas or tool. |
| `This Jev operation is outside the tool grant` / `This Jev operation requires write access` / `This action requires a proposal grant` | `server/jev/authorization.ts`, `server/jev/runtime.ts` | Token access level is too low. | Use a `propose` or `write` token. |
| `An agent cannot approve its own proposal` / `An authorized reviewer must approve the proposal` / `An authorized workspace reviewer must approve this change` | `server/jev/proposals.ts`, `server/jev/authorization.ts`, `server/jev-api-handlers.ts` | An agent tries to approve. | A person must approve in the app. |
| `Workspace owner authorization is required` / `Only the workspace owner can test this connection` | `server/jev/runtime.ts`, `server/jev-connection.ts` | Settings-level actions from an agent token. | Do it as the owner in the app. |
| `Only the initiating agent can cancel this job` / `…this draft` / `Only the initiating agent can read this draft` | `server/jev/runtime-controls.ts`, `server/jev/runtime.ts` | Another agent's job or draft. | Use the agent that started it. |
| `The authorization changed while the action was queued` | `server/jev/runtime.ts` | Token changed between queue and run. | Queue the action again. |
| `External Symbi Reflex processing is disabled` | `server/jev/actions/context.ts` | Reflex external processing is off. | Turn it on in settings, if you want it. |
| `Workspace review requires a same-origin session` / `Configure workspace authentication before remote review` | `server/jev-api-principal.ts` | Cross-origin review, or remote review without a workspace token. | Use the app on the same origin, or set an access token. |
| `The agent authorization was revoked` / `Invalid agent identity` / `An authenticated agent identity is required` | `server/jev/authorization.ts`, `server/jev-api-principal.ts` | Revoked or invalid MCP token identity. | Create a new MCP token. |

Note: when a scoped token asks for a canvas outside its scope, several routes answer `404 Canvas not found` instead of `403` (`server/api-jev.ts`, `server/api-symbi.ts`, `server/jev-api-handlers.ts`, `server/symbi-index-lifecycle.ts`). This hides which canvases exist.

### 404 Not Found: the thing does not exist (or is outside your scope)

| Message | Source | Next step |
| --- | --- | --- |
| `Route not found` | `server/index.ts` | Check the method and path. |
| `Workspace not found` / `Canvas not found` | `server/storage.ts` and many Reflex files | List canvases again; check token scope. |
| `Document not found` / `Block not found` | `server/storage.ts`, `server/storage-documents.ts`, `server/chat-proposals.ts` | The document was deleted or archived. Read the canvas again. |
| `A linked document no longer exists` / `A merge document no longer exists` | `server/storage-documents.ts`, `server/storage-merges.ts` | Review again with current documents. |
| `Layout includes an unknown block` | `server/storage-documents.ts` | Reload the canvas before saving layout. |
| `Branch not found` / `Revision not found` | `server/version-control.ts` | Call `list_versions` for valid names. |
| `Task not found` / `Task history event not found` | `server/storage-tasks.ts`, `server/storage-jev-tasks.ts` | Reload tasks. |
| `Merge not found` | `server/storage-merges.ts` | The merge journal is gone; nothing to undo. |
| `Token not found` | `server/storage-settings.ts` | The MCP token was already removed. |
| `Investigation not found` | `server/investigations.ts`, `server/investigations-files.ts` | Start a new investigation. |
| `Proposal not found` / `Pending proposal not found` / `Receipt not found` / `Job not found` / `Draft not found` / `Decision not found` | `server/jev/*`, `server/jev-api-handlers.ts` | Refresh the Reflex activity view. |
| `Requested source is excluded or unavailable` / `A requested document is unavailable` | `server/jev/context.ts`, `server/jev/actions/context.ts` | The document is excluded from Reflex or gone. |
| `Jev operation not found` | `server/jev-api-handlers.ts` | Unknown Reflex operation name. |
| `Website source folder was not found` / `Website asset not found` / `App asset not found` | `server/website.ts`, `server/api-http.ts` | Check the path. |

### 405 Method Not Allowed

`Unsupported Jev request method` (`server/jev-api-handlers.ts`): a known Reflex operation was called with the wrong HTTP method. Use the method from the endpoint list in [Symbi Reflex](symbi-reflex.md).

### 409 Conflict: something changed, or the request clashes with current state

A `409` means "your view is out of date" or "this would break a rule". Do not just retry. Read the current state, merge your change, and then try again. Over MCP, a `409` arrives as a structured `conflict` result (see [MCP tool results](#mcp-tool-results)). The families are listed in [409 conflicts by family](#409-conflicts-by-family).

### 410 Gone: a Chat proposal can no longer be used

| Message | Source | Next step |
| --- | --- | --- |
| `This Chat proposal is no longer available. Ask Chat to prepare a fresh proposal.` | `server/chat-proposal-journal.ts` | Ask Chat again. |
| `This Chat proposal expired. Ask Chat to prepare a fresh proposal.` | `server/chat-proposal-journal.ts` | Ask Chat again. |
| `This Chat proposal has already been applied. Review its receipt.` | `server/chat-proposals.ts` | Look at the receipt; do not apply twice. |
| `This applied Chat proposal is no longer available to undo. Review the current documents.` | `server/chat-proposals.ts` | Undo by hand from document history. |

### 413 Payload Too Large

| Message | Source | Next step |
| --- | --- | --- |
| `Request body is too large` | `server/api-http.ts` | API body is over 2,000,000 bytes. Split the request. |
| `Jev state is too large for a single decision. Reduce the amount of content sent.` | `server/jev.ts` | Send less content to Jev. |
| `Symbi Reflex decision exceeds the application token budget` | `server/jev/actions/context.ts` | Select fewer documents. |

### 415 Unsupported Media Type

`Send the request body as application/json` (`server/api-http.ts`). Every request with a body must send `Content-Type: application/json`. This also blocks plain HTML form posts from other sites.

### 423 Locked: another actor holds the document lock

`<owner> is editing this document until <time>. Wait, or take over the lock first.` (`server/coordination.ts`, `check`).

This happens when you change content, title, or kind, move, merge, delete, edit a branch, or switch/merge/restore versions while someone else holds the lock. Many store paths call `locks.check` (`server/storage-documents.ts`, `server/storage-merges.ts`, `server/storage-jev-executor.ts`, `server/jev/parent-undo.ts`).

Next step: wait until the time in the message, or take over with `POST /api/canvases/:id/blocks/:blockId/lock` and `force: true` (MCP: `claim_doc` with force). Taking over should be a deliberate choice.

Note the difference: *claiming* a lock that someone else holds returns `409` (`… Pass force to take it over.`). *Writing* while someone else holds it returns `423`.

### 429 Too Many Requests

`Symbi Reflex queue is full` (`server/jev/runtime-queue.ts`, `server/jev/runtime-maintenance.ts`). The workspace already has 200 pending Reflex jobs. Wait for jobs to finish. Background maintenance treats this as "skip for now" and tries later.

### 499 Cancelled

`Jev request was cancelled` (`server/jev-transport.ts`) and `Symbi Reflex evaluation was cancelled` (`server/jev/actions/context.ts`, `server/jev/runtime-question-prefetch.ts`, and others). The caller or the server aborted the work. This is not a fault. Start the action again if you still need it.

### 500 Internal Server Error

- `Internal server error`: any unexpected error. Check the server console; it logs the real error.
- `Saved investigation is invalid` (`server/investigations-schema.ts`, `server/investigations-files.ts`): a saved investigation file is broken.
- `Invalid Jev question id: …`, `Jev question … has empty instructions`, and similar (`server/jev.ts`): a Reflex question definition in code is wrong. This is a bug, not a user error.

### 502 Bad Gateway: an outside service failed

The server reached another service (model provider, TypeSafe Jev, external MCP server, site generator) and that service failed or returned bad data. See [Provider and Jev errors](#provider-and-jev-errors).

| Message (examples) | Source |
| --- | --- |
| `<provider> request failed (<status>). <reason>` / `<provider> request failed. Check the model and API key in Settings.` | `server/chat-agent-failure.ts` |
| `<provider> returned no final answer` / `<provider> returned no text` | `server/chat-agent-output.ts` |
| `Could not reach the model provider` / `The provider rejected the API key. Save a valid key first.` / `The provider returned <status> when listing models` | `server/providers.ts` |
| `TypeSafe Jev rejected the API key (401). Check the supplied API key.` / `Could not reach TypeSafe Jev` | `server/jev-transport.ts` |
| `TypeSafe Jev rate limit reached (429). Try again shortly.` / `TypeSafe Jev is overloaded (529). Try again shortly.` / `Jev request failed (<status>): <detail>` | `server/jev-transport.ts` |
| `Jev returned invalid JSON` / `Jev response is too large` / `Jev returned no answers` / `Jev returned an invalid score` | `server/jev-transport.ts`, `server/jev.ts`, `server/jev-answers.ts` |
| `Invalid decision result` / `Decision evidence does not match its source` / `Unknown decision source` | `server/jev/runtime-guards.ts` |
| `Could not connect to <server>: <reason>` | `server/external-mcp.ts` |
| `<generator> build failed: <stderr>` | `server/website.ts` |

### 503 Service Unavailable: a needed part is missing or needs recovery

| Message | Source | Next step |
| --- | --- | --- |
| `The local search index is unavailable` | `server/api-symbi.ts` | The search index did not open. Check server start-up logs. |
| `Judgment recovery is unavailable` | `server/api-symbi.ts` | The judgment cache did not open. |
| `Symbi Reflex is unavailable: configure a TypeSafe API key` | `server/jev/actions/context.ts` | Save a TypeSafe key in settings. |
| `Connect a processing provider before resetting Jev` / `Enable automatic processing before resetting Jev` | `server/jev/runtime.ts` | Set up processing first. |
| `Symbi Reflex workspace state requires recovery` / `… journal requires recovery` / `… vocabulary requires recovery` / `… processing settings require recovery` | `server/jev/workspace*.ts` | A saved Reflex file is unreadable or fails its checks. Restart so recovery runs; if it repeats, inspect `jev/workspaces/<id>/` in the data folder. |
| `Saved group approval requires recovery` / `Staged draft requires recovery` / `Parent Undo recovery metadata requires repair` | `server/jev/group-approval.ts`, `server/jev/drafts.ts`, `server/jev/parent-undo.ts` | Same: a saved recovery file is damaged. |
| `Symbi Reflex recovery conflicts with a later change` / `Reviewed content recovery conflicts with a newer edit` | `server/storage-jev-executor.ts` | Recovery stopped because a person edited the document later. Review by hand. |
| `<generator> is not installed on this server` | `server/website.ts` | Install mkdocs, hugo, or docusaurus. |

Group approval is special. If one change in a group fails, the error says how many were saved: `<n> of <m> group changes are saved. <reason>`. It keeps the original status, or uses `503` for non-`ApiError` failures (`server/jev/group-approval.ts`).

## 409 conflicts by family

### Content hash (someone edited the text)

| Message | Source | Next step |
| --- | --- | --- |
| `This document changed since you read it. Read it again and reapply your edit.` + `currentContentHash` | `server/storage-validation.ts` | Read, merge, retry with the new hash. |
| `This document changed since you read it. Read it again before deleting.` + `currentContentHash` | `server/document-deletion.ts` | Read again, then decide. |
| `This branch changed since you read it. Current contentHash: <hash>` | `server/storage-documents.ts` | Read the branch again. |
| `The document changed since this suggestion was reviewed` | `server/storage-documents.ts` | Review the suggestion again. |
| `The source changed since this decision` | `server/jev-api-handlers.ts` | Ask Reflex again. |
| `The source changed since Symbi Reflex reviewed it` / `The document changed during automatic processing` / `The reviewed draft needs rebase` | `server/jev/stamps.ts`, `server/jev/runtime-document.ts`, `server/storage-jev-executor.ts` | Reflex will need a fresh review. |
| `Save or discard your unsaved editor changes before Symbi edits this document.` | `server/chat-tools.ts` | Save or discard in the editor first. |

### Task revision

| Message | Source | Next step |
| --- | --- | --- |
| `The task changed since this suggestion was reviewed` | `server/storage-tasks.ts` (`expectedRevision`, `expectedUpdatedAt`) | Reload the task and apply again. |
| `A source document changed since this suggestion was reviewed` | `server/storage-tasks.ts` (`expectedSourceStateHashes`) | Review the task suggestion again. |
| `The task changed since this history event was reviewed` / `A task changed after this history event` | `server/storage-tasks.ts` (task undo) | Reload history. |
| `The task changed since Symbi Reflex reviewed it` / `Task identity already exists` / `Other work now depends on this task` | `server/storage-jev-tasks.ts` | Review the Reflex suggestion again. |

### Review token (document state)

| Message | Source |
| --- | --- |
| `This document changed since review. Read it again before applying this change.` (`expectedDocumentState`) | `server/document-deletion.ts` |
| `Document changed since review` (`expectedStateHash` on move) | `server/storage-documents.ts` |
| Caller-supplied message from `checkBlockStateHashes` | `server/storage-state.ts` |

Next step: read the document again to get a fresh review token, then apply. See [Safe collaboration](safe-collaboration.md).

### Cross-links

| Message | Source |
| --- | --- |
| `This document has saved source links that need review before applying this change.` (`expectedSavedCrossLinks`) | `server/document-deletion.ts` |
| `This document has a new reference. Review it before deleting.` / `This document has a new cross-canvas reference. Review it before deleting.` | `server/document-deletion.ts` |
| `The linked document changed since this suggestion was reviewed` | `server/storage-documents.ts` |
| `Merging these documents would exceed the cross-canvas link limit. Review their links first.` | `server/merge-references.ts` (limit 20) |
| `Moving this document would exceed the cross-canvas link limit. Review its links first.` | `server/document-moves.ts` (limit 20) |

Next step: open the links, decide what to keep, then try again.

### Merges (document merges and Git merges)

| Message | Source |
| --- | --- |
| `A merge document changed. Review the proposed merge again.` | `server/storage-merges.ts` |
| `Documents changed since the merge` / `Cross-canvas links changed since the merge` / `Merge already undone` | `server/storage-merges.ts` (merge undo) |
| `Documents changed since the interrupted merge` / `Cross-canvas links changed since the interrupted merge` | `server/merge-recovery.ts` |
| `Merge conflict in this document. No changes were applied.` | `server/version-control.ts` (branch merge and merge preview) |
| `Merge failed and could not be rolled back: <reason>` | `server/version-merge-recovery.ts` |

Next step: for document merges, preview again. For a Git merge conflict, edit one branch so they agree, then merge again. "Could not be rolled back" needs a person to look at the document history.

### Moves and placement

| Message | Source |
| --- | --- |
| `The destination canvas cannot hold the tasks attached to this document.` | `server/document-moves.ts` (500-task limit) |
| `No free position is available near the requested coordinates` | `server/storage-validation.ts` |

### Idempotency keys

| Message | Source | Next step |
| --- | --- | --- |
| `This idempotency key already belongs to a different document` | `server/storage-documents.ts` | Same key, different title, content, or kind. Use a new key. Same key with the same values returns the existing document. |
| `Operation key was already used with different arguments` | `server/jev/runtime-queue.ts` | Use a new Reflex `idempotencyKey`. |

### Branch rules

| Message | Source |
| --- | --- |
| `This document has uncommitted changes. Save them before switching branches.` | `server/version-control.ts` |
| `Use the visible document edit for the current branch` | `server/version-control.ts` (branch edit on the current branch) |
| `The current or protected branch cannot be deleted` | `server/version-control.ts` (`main` or current) |
| `This branch has unmerged work and cannot be deleted` | `server/version-control.ts` |
| Git's own message (for example, branch already exists) | `server/version-control.ts` (`createBranch`) |

### Locks and claims

| Message | Source | Next step |
| --- | --- | --- |
| `<owner> is editing this document until <time>. Pass force to take it over.` | `server/coordination.ts` (claim) | Wait, or claim with `force: true`. |
| `<owner> holds this document. Pass force to release it.` | `server/coordination.ts` (release) | Only the owner should release (`DELETE …/lock?force=1` forces it). |
| `<assignee> already claimed this task. Pass force to take it over.` | `server/coordination.ts` (task claim) | Talk to the assignee or use force. |

### Symbi Reflex state

| Message | Source |
| --- | --- |
| `Proposal is no longer pending` | `server/jev/proposals.ts`, `server/jev/runtime.ts` |
| `Symbi Reflex is paused` / `Symbi Reflex action is paused or disabled` | `server/jev/proposals.ts`, `server/jev/group-approval.ts`, `server/jev/runtime-queue.ts` |
| `The processing policy changed` / `The action was cancelled or its policy changed` | `server/jev/runtime.ts`, `server/jev/runtime-guards.ts` |
| `Another reviewed draft is active for this document` / `An applied draft must use checked Undo` / `The current draft requires complete review and approval` | `server/jev/drafts.ts`, `server/jev/runtime-controls.ts`, `server/storage-jev-executor.ts` |
| `A later correction prevents this Undo` / `A later pin prevents this Undo` / `Work changed after this action; Undo is unavailable` | `server/jev/proposal-inverse.ts`, `server/jev/move-task-inverse.ts` |
| `Vocabulary changed since the preview` / `Vocabulary name or group path collision` / `Approve an active parent group first` | `server/jev/vocabulary.ts` |
| `This group contains competing changes to the same document. Review them individually.` / `An earlier approval was undone. Review a fresh suggestion.` | `server/jev/group-approval.ts` |
| `Recover pending Reflex changes before resetting` | `server/jev/reset.ts` |

Next step: refresh the Reflex view. Undo is blocked on purpose when a person changed the document later; fix it by hand from history.

### Other 409s

| Message | Source | Next step |
| --- | --- | --- |
| `Investigation changed. Reload it before saving.` | `server/investigations.ts` | Reload, then save. |
| `This Chat proposal is already being <action>` | `server/chat-proposals.ts` | Wait for the first apply or undo to finish. |
| `Continuation source or scope changed; start a new question` | `server/api-symbi.ts` | Ask again without the continuation id. |

## Provider and Jev errors

### Chat model providers

`server/chat-agent-failure.ts` turns provider failures into `502` errors with a short reason. A `4xx` `ApiError` from SymbiKnow itself passes through unchanged.

| Upstream status | Reason added to the message |
| --- | --- |
| 400 | `The request is too large for this model.` / `The model rejected the agent tools.` / `The model rejected this request.` |
| 401 | `The API key was rejected. Check it in Settings.` |
| 402 | `The account has insufficient credits. Check billing with the provider.` |
| 403 | `This key cannot use the selected model. Check provider access and Settings.` |
| 404 | `The selected model was not found. Choose another model in Settings.` |
| 408, 504 | `The provider timed out. Retry the request.` |
| 429 | `The provider rate limit was reached. Retry shortly.` |
| 500 | `The provider had an internal error. Retry shortly.` |
| 502, 503 | `The provider is unavailable. Retry shortly.` |
| other | `Check the provider status and retry.` |

The status is read from `status` or `statusCode` on the error (up to three `cause` levels deep), or from text like `status code 429` in the message.

### TypeSafe Jev transport

`server/jev-transport.ts` calls `https://api.typesafe.ai/v1/systemone`:

- Each attempt has a 20-second timeout.
- By default it retries up to 2 times. It retries on network errors and on status 429, 500, 502, 503, 504, and 529.
- The wait doubles from 500 ms (with ±25% jitter), up to 5 seconds. It honours `Retry-After` up to 10 seconds. A longer `Retry-After` stops the retries.
- Interactive calls (`ask_symbi` judgments, the connection test, question batches in `server/jev/actions/context.ts`) use `maxRetries: 0`.
- A `401` from TypeSafe becomes `502 TypeSafe Jev rejected the API key (401)…`.
- Other failures become `502` through `jevRemoteError` (`server/jev-provider-error.ts`). It privately marks two kinds:
  - **Billing failure**: upstream `402`. Reflex does not retry these.
  - **Context-limit failure**: upstream `400` with "max tokens exceeded". Reflex may split the question batch and try again (`server/jev/actions/question-batch-recovery.ts`).
- Responses over 262,144 bytes fail with `Jev response is too large`.

### How Reflex records failures

High level, from `server/jev/runtime.ts`, `server/jev/runtime-maintenance.ts`, and `server/jev/followups.ts`:

1. **Job retry.** A job that fails with 429, 502, 503, or 504 (not a billing failure) goes back to `queued` while it has had fewer than 2 attempts. It waits `250 ms × attempts` first.
2. **Failed job.** Otherwise the job state becomes `failed`. `job.error` holds the public message: the `ApiError` text, or `Symbi Reflex could not complete the operation; Retry is available`. Any open draft for the job is stopped.
3. **Document cooldown.** For a document plan that failed for a provider reason (429/502/503/504) or was aborted, Reflex sets `retryAt` 60 seconds later. Aborted jobs get a clear message: `Automatic document execution timed out`, `…interrupted by shutdown`, or `…cancelled before completion`. Maintenance re-queues the job after `retryAt` if Reflex is not paused, the policy and authorization did not change, and the sources still exist and match. A `404` or `409` on that check drops the retry.
4. **Organization cooldown.** A failed organization step stores `organizationFailedContextKey` and `organizationRetryAt` (60 seconds later) on the document profile.
5. **Provider unavailable.** For 401, 402, 403, 429, 502, 503, or 504, the follow-up chain for that job is ended instead of continued.
6. **Queue full.** `429 Symbi Reflex queue is full` at 200 pending jobs.

See [Symbi Reflex](symbi-reflex.md) for the full processing flow.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `401 Sign in with the workspace access token` after a restart | `SYMBIKNOW_ACCESS_TOKEN` changed; the old session cookie no longer matches. | Sign in again with the new token. Update agent configs that send the token. |
| `401 Missing or invalid MCP token…` from `/mcp` | MCP token deleted or mistyped. | Create a new token in Settings → Connect agents. |
| `403 Requests from sandboxed documents are not allowed` | A sandboxed HTML document tried to POST/PUT/DELETE. | Expected. Sandboxed HTML can only read. Make the change in the app. |
| `403 A reviewed draft is active…` from an MCP write | A Reflex draft is open on that document. | Resume, rebase, or cancel the draft, then write. |
| `404 Canvas not found` for a canvas that exists | Token scope does not include that canvas. | Use a token with that canvas, or widen the scope. |
| MCP result `code: "conflict"` | Someone changed the document after your `read_doc`. | `read_doc` again, merge, and retry with the new `contentHash`. |
| `423 … is editing this document until …` | Another actor holds the lock. | Wait, or claim with `force: true` if you are sure. |
| `415 Send the request body as application/json` | Missing `Content-Type` header. | Add `Content-Type: application/json`. |
| `413 Request body is too large` | Body over 2 MB. | Send fewer or smaller documents. |
| `503 The local search index is unavailable` | The search index did not open at start-up. | Check the server log; restart the server. |
| Search works but `coverage.status` is `degraded` with `Offline INT8 MiniLM model is missing under …` | `SYMBI_MODEL_ROOT` is not set, or the model file is not there (`server/symbi-embedding-worker.mjs`). Search falls back to keywords. | Put `Xenova/all-MiniLM-L6-v2/model_int8.onnx` under `SYMBI_MODEL_ROOT` and restart. See [Search and brain tools](search-and-brain-tools.md). |
| `Pinned INT8 MiniLM model checksum mismatch` | Wrong model file. | Replace it with the pinned revision. |
| `503 Symbi Reflex is unavailable: configure a TypeSafe API key` | No TypeSafe key saved. | Save the key in settings. |
| `502 TypeSafe Jev rejected the API key (401)…` | Wrong TypeSafe key. | Save a valid key; use the connection test. |
| Reflex jobs fail with `TypeSafe Jev rate limit reached (429)` | Too many calls. | Wait. Reflex retries and sets a 60-second cooldown on document plans. |
| `429 Symbi Reflex queue is full` | 200 jobs pending. | Wait, or pause Reflex while it catches up. |
| `502 <provider> request failed (401)…` in Chat | Wrong chat provider key. | Fix the key in Settings. |
| `400 Choose a <provider> model in Settings before using chat` | No chat model selected. | Pick a model in Settings. |
| Chat stops mid-answer with `Chat stream stopped. Check the model settings.` | A non-`ApiError` failure after streaming began. | Check model settings and the server log. |
| `Canvas server is unavailable or restarting (502)` in the browser | The server is down or restarting behind a proxy. | Wait and retry; check that the server runs. |
| MCP tool fails with `Canvas API is unavailable at <url>` | The stdio MCP server cannot reach the HTTP API. | Start the SymbiKnow server, or fix the API base URL. |
| `410 This Chat proposal expired…` | The proposal journal entry is gone or too old. | Ask Chat for a new proposal. |
| `503 … requires recovery` | A saved Reflex or recovery file is damaged. | Restart so recovery runs; if it repeats, check the files under the data folder. |
| `500 Internal server error` | An unexpected bug. | Read the server console log. |

## Further reading

- [Safe collaboration](safe-collaboration.md): hashes, review tokens, locks, and branches.
- [MCP and API](mcp-and-api.md): tools, tokens, and HTTP routes.
- [Security and access](security-and-access.md): tokens, principals, and request hygiene.
- [Document operations](document-operations.md): moves, merges, deletes, and imports.
- [Symbi Reflex](symbi-reflex.md): the Reflex engine and its jobs.
- [Search and brain tools](search-and-brain-tools.md): the search index and the embedding model.
