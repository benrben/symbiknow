# SymbiKnow API contract

All JSON endpoints use `/api` and return `{ error: string }` on failure. Request bodies must be sent as `application/json` (other types get `415`), and writes from a sandboxed document (`Origin: null`) get `403`. When `SYMBIKNOW_ACCESS_TOKEN` or the legacy `ALLTEAM_ACCESS_TOKEN` is set, every route except `/session` needs the session cookie or `Authorization: Bearer <access token>` (`401` otherwise). If both variables are set, either token is accepted and existing cookies stay valid while their token remains configured.

Send `x-symbiknow-actor: <name>` to name the author of document revisions and locks. The browser sends `Browser`; MCP agents use their authenticated caller ID for shared writes and locks; client display names remain separate. The legacy `x-allteam-actor` header, `allteam_session` cookie, and `ALLTEAM_*` environment aliases remain supported for existing integrations. New browser sessions use `symbiknow_session`.

| Method | Path | Input | Output |
| --- | --- | --- | --- |
| GET | `/workspaces` | — | `WorkspaceSummary[]` |
| POST | `/workspaces` | `{ name }` | `WorkspaceSummary` |
| GET | `/canvases/:canvasId` | — | `CanvasDocument` |
| GET | `/canvases/:canvasId?summary=1` | — | Fresh canvas metadata; blocks have `content: ""` and `contentLoaded: false`. No document bodies, hashes, or ETags are read. |
| GET | `/canvases/:canvasId/blocks/:blockId` | — | One current `CanvasBlock`, including full content and its hash; reads only the selected document. |
| DELETE | `/canvases/:canvasId` | — | `{ ok: true }`; permanently removes the canvas, its documents, cache, and document histories |
| PUT | `/canvases/:canvasId/layout` | `{ positions: { blockId, x, y, group?: string \| null }[] }` | `CanvasDocument` |
| POST | `/workspaces/:workspaceId/canvases` | `{ name }` | `CanvasDocument` |
| GET | `/canvases/:canvasId/todos` | — | `CanvasTask[]`, including archived (`done`) tasks |
| POST | `/canvases/:canvasId/todos` | `{ title, detail?, priority?, size?, dueDate?, assignee?, status? }` | Saved `CanvasTask` (201) |
| PUT | `/canvases/:canvasId/todos/:taskId` | Partial task fields plus required `expectedRevision` | Saved `CanvasTask`; 409 if another writer changed it |
| POST | `/canvases/:canvasId/blocks` | `{ title, kind?, content?, x?, y? }` | `CanvasBlock` |
| PUT | `/canvases/:canvasId/blocks/:blockId` | Partial `CanvasBlock`, plus optional `expectedContentHash` (`409` if the file changed), `expectedDocumentState` (review token), `expectedSavedCrossLinks` (saved-reference review), and `message` (revision message) | `CanvasBlock`; `423` if another actor holds the lock and the change touches content, title, or loader |
| POST | `/canvases/:canvasId/blocks/:blockId/move` | `{ targetCanvasId }` | Moves within the workspace and preserves typed references |
| POST | `/canvases/:canvasId/blocks/:blockId/lock` | `{ ttlSeconds?: 30–3600, note?, force? }` | `{ owner, expiresAt, note? }`; `409` if held by another actor |
| DELETE | `/canvases/:canvasId/blocks/:blockId/lock[?force=1]` | — | `{ ok: true }` |
| DELETE | `/canvases/:canvasId/blocks/:blockId` | Optional JSON `{ expectedDocumentState?: string, expectedSavedCrossLinks?: string, requireUnreferenced?: boolean }` | `{ ok: true }`; `409` when reviewed state or saved outgoing links changed, or a required reference check finds a saved incoming reference |
| GET | `/canvases/:canvasId/blocks/:blockId/download` | — | Raw `.md` attachment |
| GET | `/canvases/:canvasId/blocks/:blockId/versions` | — | `{ current, branches, commits }` for one file |
| POST | `/canvases/:canvasId/blocks/:blockId/versions/branches` | `{ name }` | Updated file version status |
| POST | `/canvases/:canvasId/blocks/:blockId/versions/switch` | `{ name }` | Updated file version status |
| POST | `/canvases/:canvasId/blocks/:blockId/versions/merge` | `{ name }` | Updated file version status; `409` on conflict |
| POST | `/canvases/:canvasId/blocks/:blockId/versions/restore` | `{ revision }` | Updated file version status with a new restore commit |
| GET | `/search?q=...` | — | `{ canvasId, blockId, title, excerpt }[]` |
| GET | `/settings` | — | `ChatSettings` (never includes keys, secret values, or token values) |
| PUT | `/settings` | `{ provider?, model?, baseUrl?, apiKey? (for the selected provider), providerKeys?, systemPrompt?, agentProfile?, customProfiles?, agentPlugins?, secrets?: { NAME: value \| null }, mcpServers?, groupBy? }` | `ChatSettings` |
| GET | `/models?provider=` | — | `{ id, name, tools?, context? }[]` from the provider |
| POST | `/mcp/servers/test` | `{ url, name?, bearerSecret?, headers? }` | `{ ok, server, tools: { name, description }[] }` |
| GET | `/mcp/info` | — | `{ origin, endpoint, publicUrlConfigured, accessProtected, activeSessions }` |
| POST | `/mcp/tokens` | `{ name }` | `{ token, settings }` — the token is shown only here |
| DELETE | `/mcp/tokens/:id` | — | `ChatSettings` |
| GET / POST / DELETE | `/session` | POST `{ token }` | `{ authRequired, authenticated }`; POST sets the session cookie |
| POST | `/chat` | `{ canvasId, messages: ChatMessage[] }` | `{ message, changed, proposalId? }`; uses the selected provider and enabled tools; proposed document edits require review |
| GET | `/chat/proposals/:proposalId` | — | Review proposed document changes |
| POST | `/chat/proposals/:proposalId/apply` | `{ changeIds?: string[] }` | Applies selected changes, or `409` with conflicts if sources changed |
| POST | `/chat/proposals/:proposalId/undo` | `{}` | Undoes applied changes, or `409` when later edits prevent a safe undo |
| POST | `/chat/stream` | `{ canvasId, messages: OpenAI chat messages[], viewContext?: ChatViewContext, previewMerge? }` | OpenAI Chat Completions SSE stream of live tokens, plus `agent_step`, `answer_reset`, `answer_canvas`, `research_canvas_patch`, `canvas_navigation`, and `error` events; validation errors are JSON |

Task status `done` automatically moves work to Archive; `todo` reopens it. Priorities, effort sizes, revision rules, and MCP tools are documented in the [canvas task guide](docs/todos.md).

## Session research canvas events

`viewContext` describes what the browser currently shows: selected and visible block IDs, the active and visible groups, search text, reader or focused block, viewport zoom, and the focused answer or source when the session research canvas is open. It guides source ranking, navigation, answer placement, and follow-up suggestions. The context is advisory; the server checks documents and permissions before acting.

An explicit research request can produce an `answer_canvas` event containing `{ query, canvasId, selection, sources, layout?, surface? }`. Sources are selected locally and have canvas/block IDs, titles, excerpts, relevance scores, and optional content hashes. New results use `selection: local`; legacy saved research may retain its previous label. A `canvas_navigation` event names the document or group to reveal.

For a canvas answer, `research_canvas_patch` contains `{ query, layout?, blocks, edges }`. A block has an ID, semantic type (`text`, `diagram`, `task`, or `section`), title, content, source IDs, and an optional loader kind (`markdown`, `html`, `slides`, `mdx`, or `website`). Edges use `from`, `to`, and an optional label. Source IDs are `canvasId:blockId` references to selected documents. Clients add patches to the current chat session's graph; another question does not replace prior turns. The browser renders citations inside answer blocks and checks cited source hashes for changes. This temporary graph is client session state, not a stored canvas. **Save canvas** creates a regular workspace canvas through the existing canvas and block routes; **Export Markdown** is a client-side download. **New chat** or a page reload clears unsaved research.

## Symbi Reflex automatic jobs

Symbi Reflex uses the `/jev` integration namespace. Its endpoints are available under `/api/workspaces/:workspaceId/jev` and `/api/canvases/:canvasId/jev`; a canvas request derives its workspace from the saved canvas. Jobs and review state are durable and workspace scoped.

| Method | Suffix | Input | Output |
| --- | --- | --- | --- |
| GET | `/state` | — | Scoped settings, jobs, proposals, receipts, vocabulary, and profiles |
| PUT | `/settings` | Partial `{ confidenceThresholds, paused, externalProcessing, people }` | Updated settings; owner only |
| POST | `/connection` | `{}` | Checks the saved TypeSafe key without document content; owner only |
| POST | `/actions` | `{ action, canvasId?, blockIds?, query?, options?, idempotencyKey? }` | Queued job; poll `/state` for results |
| POST | `/jobs/:jobId/cancel` | `{}` | Cancelled job |
| POST | `/groups/approve` | `{ groupKey, proposalIds }` | Approves the reviewed group definition, required parents, and document memberships; checks all sources before writes, persists progress and receipts, and reports any interrupted approval |
| POST | `/proposals/:proposalId/revise` | `{ mutation }` | Revised proposal |
| POST | `/proposals/:proposalId/apply` | `{}` | Checked receipt; authorized reviewer only |
| POST | `/proposals/:proposalId/dismiss` | `{}` | Dismissed proposal |
| POST | `/proposals/:proposalId/suppress` | `{}` | Suppressed suggestion |
| POST | `/receipts/:receiptId/undo` | `{}` | Checked inverse; authorized reviewer only |
| GET | `/drafts/:blockId` | — | Current staged edit; canvas endpoint only |
| POST | `/drafts/:blockId/cancel` | `{ draftId }` | Cancels that exact staged edit; authorized reviewer only |
| POST | `/undo-parent` | `{ kind, before?, after }` | Checks parent and automatic descendants before causal Undo; canvas endpoint, reviewer only |

Actions use the six names in [`shared/jev-types.ts`](shared/jev-types.ts). All retained actions use Auto. A configured `TYPESAFE_API_KEY` starts source analysis and dependent checks without an action request. Existing workspace policies migrate automatically; retired action names, review/off modes, allowlists and digest schedules cannot be configured. Source and workspace-context changes refresh the workflow; unchanged context does not repeat it. The historical approval/Undo endpoints support existing receipts and restricted agent proposals, and are not part of the automatic UI.

`confidenceThresholds` is a partial map from those six action names to finite numbers from `0.5` to `1`. Defaults are `0.7`; partial updates preserve the other actions' thresholds. Each semantic classification and required supporting judgment must meet its action's threshold. Representative source quote selection keeps its exact-byte evidence check independently. A changed profile threshold refreshes the saved profile and dependent checks; other threshold changes refresh dependent checks without discarding a current profile. Saved analysis retains confidence values and marks below-threshold conclusions uncertain.

Automatic saves check exact source evidence, current revisions, ownership, and permissions. Manual classifications and assignments are preserved, unsupported changes are skipped with a recorded reason, and missing credentials leave ordinary work available. Duplicate assessments are persisted findings; they never rewrite or merge source content. Label candidates come from existing tags or active definitions, with bounded source headings and shared categories as a fallback; label evaluation does not maintain vocabulary. Historical conflict, quality, task, responsibility, and recall results remain readable and undoable.

Scoped MCP bearer tokens can access these endpoints within their canvas and tool grants. The `/agent` variant is used by MCP adapters and checks current explicit approval and configuration grants. Read tokens receive only the requested tool projection through `?view=jev_activity|jev_job|jev_profile|find_by|related|memory_map|brain_inbox`; `jobId`, `blockId`, and `query` select within that projection. Actor headers name contributions and never grant reviewer authority. Internal MCP calls carry a signed principal proof and recheck current grants. Approval requires an explicit `canApprove` grant; Symbi has this grant as the full-access application assistant.

## Document storage and the independent Jev SDK

The engine and typed SDK remain independent at `server/sdk.ts` and compile to `dist/sdk/sdk.js`. See the [SDK reference](docs/jev/sdk-reference.md).

The server owns `.md` files and the canvas layout. The browser receives file contents through the API and does not receive saved API keys. A `website` block's Markdown contains frontmatter with `generator` and `source` fields; the site preview loader requests its build through a dedicated server route.

Each document has a separate Git repository under `DATA_DIR/.versions/<block-id>`. Source changes create revisions for that file. Branch switching, merging, and restoring copy only that file's source back to its Markdown document. Canvas layout and other documents are unaffected. The stdio project MCP server uses this API as its shared writer; WebMCP tools call the same API from the browser.

Agent Undo uses the opaque token returned by `shared/document-state.ts`'s `documentReviewState` helper from a native document snapshot. It covers saved content versions and document metadata while excluding transient locks. Both update and deletion check this token inside the serialized write, before changing files or history. Checked deletion also rejects saved incoming references on other canvases, including archived sources. An empty DELETE body keeps the existing deletion behavior; a nonempty body must be JSON with valid precondition types (`400` otherwise).

`expectedSavedCrossLinks` is the JSON string of the reviewed document's original outgoing cross-canvas links (`JSON.stringify(snapshot.crossLinks ?? [])`). Both writes compare it with the saved links before changing files or history, including links hidden from the current view because their targets are archived or temporarily missing. A mismatch returns `409` and preserves those references for review.

`CanvasBlock` retains saved groups, purpose/work-area/reviewer labels, tags, typed links, `contentHash`, and active locks, together with server-owned incarnation, generation, metadata revision, and metadata ownership. Manual metadata and layout updates continue through the ordinary document and layout routes. Chat uses the selected model provider and the canonical MCP catalog under Symbi’s full-access identity. Symbi edits downloaded working files and commits them through `upload_file`; proposal mode is available for callers with proposal access. Document deletion, layout, and link operations use their canonical permissioned MCP tools. Symbi Reflex decisions are advisory unless the checked execution policy permits the requested change.

## MCP over HTTP

`/mcp` (outside `/api`) is a Streamable HTTP MCP endpoint with sessions. Authenticate with `Authorization: Bearer <MCP token>` or use `/mcp/t/<token>` for clients that cannot send headers. Tokens come from `POST /api/mcp/tokens`, `SYMBIKNOW_MCP_TOKEN`, or either configured access token. The older `ALLTEAM_MCP_TOKEN` remains accepted. HTTP and stdio share one canonical catalog and execution contract. HTTP file transfers carry bytes and manifests; each client materializes files in its own environment. Stdio additionally accepts paths in the environment hosting the MCP process. Discovery and execution recheck current token grants.


## MCP working-copy file contract

MCP is the shared-document access and commit boundary for Symbi and external agents. Search/read tools remain available. Content changes use **download → local edit → upload → verify**. Settings exposes `mcpToolCatalog` from the canonical registrations rather than a separate tool list.

| Operation | Input | Result |
| --- | --- | --- |
| `download_file` | `canvasId`, `blockId`, optional `branch`; stdio also accepts `destinationPath`, `overwrite` | Exact source, format-aware filename, authoritative working-copy manifest |
| `upload_file` create | `mode: "create"`, `canvasId`, `filename`, complete `content`, `idempotencyKey`; optional `kind`, title, and placement | New document and durable revision receipt |
| `upload_file` replace | `mode: "replace"`, `canvasId`, `checkoutId`, `filename`, edited `content`, `idempotencyKey` | Commit to the checked-out document and branch after version/lock validation |
| `upload_file` propose | Same checkout inputs with `mode: "propose"` | Durable file proposal while saved source remains unchanged |
| File review | `read_file_proposal`, `apply_file_proposal`, `undo_file_proposal` with `canvasId` and `proposalId` | Checked proposal lifecycle; apply/undo require explicit approval authority |

Stdio upload can use `sourcePath` instead of content. Symbi accepts an edited `sourcePath` in its conversation workspace; its client adapter reads the file and uses the adjacent `.symbi.json` manifest. External HTTP clients perform the same local-file conversion in their own environment.

The manifest contains `checkoutId`, `callerId`, `workspaceId`, `canvasId`, `documentId`, `incarnation`, `branch`, `filename`, `title`, `kind`, `storageKind`, `baseContentHash`, `baseRevision`, and creation time. Website checkouts also bind the package hash. The server keeps the authoritative checkout record; editing a sidecar does not grant access or change the base version.

Uploads return `operationId`, `mode`, `canvasId`, `blockId`, `branch`, `contentHash`, `revision`, `kind`, `filename`, `title`, `savedAt`, and optional `proposalId`. Identical retries return the original receipt. Changed payloads under the same key fail. Stale document or website asset versions fail with `409`; preserve the local edits and merge against a new download before retrying.

| API endpoint | Purpose |
| --- | --- |
| `GET /api/mcp/caller` | Resolve the caller's authenticated identity and current permissions for a stdio host |
| `POST /api/mcp/calls` | Record sanitized tool outcome, source IDs, and revision under the authenticated caller |
| `POST /api/file-checkouts` | Authorize and issue a versioned working copy |
| `POST /api/file-uploads` | Commit or propose uploaded file bytes |
| `GET /api/file-proposals/:id?canvasId=` | Read an uploaded proposal or receipt |
| `POST /api/file-proposals/:id/apply` | Apply a proposal after checked version validation |
| `POST /api/file-proposals/:id/undo` | Undo an applied proposal when the saved result remains current |

Symbi has unrestricted write, approval, and configuration permissions. External tokens use `access`, optional `allowedCanvasIds` and `tools`, and explicit write-level `canApprove`/`canConfigure` grants. Full permissions retain concurrency protection. Jev search and evidence tools (`ask_symbi`, `symbi_reflex`, `find_by`, `related`) and Reflex action/job tools belong to the canonical catalog.

Agent API requests must match the canonical tool's registered method, route, and argument contract. Scope checks apply to source and target canvases. Raw document create/edit/import API routes remain available to the workspace owner; agents commit source through the file upload contract. Storage operations recheck token authority and cancellation after waiting for serialization.
