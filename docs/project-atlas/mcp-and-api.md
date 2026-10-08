# MCP and API

How agents connect, which tools they get, how tokens are scoped, and the HTTP API every client uses underneath.

## Three ways for an agent to connect

| Transport | Where | Notes |
| --- | --- | --- |
| Streamable HTTP | `<PUBLIC_URL>/mcp` with `Authorization: Bearer <token>` | Recommended for Claude Code, Codex, Cursor, remote agents |
| Token-in-path | `<PUBLIC_URL>/mcp/t/<token>` | For Claude.ai / Claude Desktop custom connectors that cannot send headers; treat the URL as a secret |
| stdio | `npm run mcp` (`server/mcp.ts`) | Same machine only; reads `CANVAS_API_URL`; `upload_file`/`download_file` can use local paths |
| WebMCP | Browser tab + `./node_modules/.bin/webmcp --mcp` | Uses the browser owner's authenticated session through the canonical MCP bridge |

`server/mcp-registry.ts` supplies one canonical tool catalog, including schemas, handlers, required permissions, and audit metadata. Symbi uses the SDK in-memory transport with full permissions; HTTP and stdio clients execute the same contracts. Shared writes and locks use a stable authenticated caller ID. Display names remain available separately for activity presentation.

WebMCP discovers and invokes those registrations through `/api/mcp/browser`. The bridge authenticates the current workspace-owner browser session and issues an internal owner identity for canonical execution.

### Configuration examples

```json
// .mcp.json (Claude Code)
{ "mcpServers": { "symbiknow": { "type": "http", "url": "https://symbiknow.example.com/mcp",
  "headers": { "Authorization": "Bearer ${SYMBIKNOW_MCP_TOKEN}" } } } }
```

```toml
# ~/.codex/config.toml
[mcp_servers.symbiknow]
url = "https://symbiknow.example.com/mcp"
bearer_token_env_var = "SYMBIKNOW_MCP_TOKEN"
```

```sh
claude mcp add --transport http symbiknow https://symbiknow.example.com/mcp --header "Authorization: Bearer <token>"
```

## Tokens and scopes

Create tokens in **Settings → MCP connections**. They are stored hashed, show last use, and can be revoked. Discovery and every execution recheck current grants, including changes within an existing session.

The stdio host resolves its authenticated identity through `GET /api/mcp/caller` for discovery and execution. The API checks each agent request against the method, path, argument schema, and permissions declared with the canonical tool registration. A tool header cannot authorize a different operation. Queued storage operations recheck authority and cancellation before changing state. `POST /api/mcp/calls` records sanitized tool outcomes with the server-resolved caller identity; document source and raw arguments stay out of the audit payload.

| Grant | Effect |
| --- | --- |
| `access: read` | Read sources, download working copies, and use retrieval tools |
| `access: propose` | Read plus `jev_do` and reviewable file uploads; committed create/replace uploads remain denied |
| `access: write` | Authorized content commits and typed document, task, layout, and version operations |
| `allowedCanvasIds` | Limits discovery results and operations to selected canvases; omitted means every canvas |
| `tools` | Limits the canonical tool names available to the caller |
| `canApprove` | Explicit write-level grant for file proposal and Reflex approval/undo tools |
| `canConfigure` | Explicit write-level grant for Reflex configuration |

Symbi has write, approval, and configuration authority across all canvases. Full permissions retain version checks and editing locks.

## Canonical tool catalog

Settings returns `mcpToolCatalog` derived from the same registrations used by MCP discovery; there is no separately maintained browser list. The current application catalog contains 42 tools. Every tool in the following table comes from the application MCP server; Symbi, HTTP, stdio, and WebMCP use those same registrations.

| Group | Tools |
| --- | --- |
| Find | `list_canvases`, `read_canvas`, `search_docs`, `read_doc`, `ask_symbi`, `symbi_reflex`, `find_by`, `related` |
| Files | `download_file`, `upload_file` |
| File review | `read_file_proposal`, `apply_file_proposal`, `undo_file_proposal` |
| Documents and layout | `delete_doc`, `move_block`, `move_document`, `link_blocks`, `unlink_blocks` |
| Coordinate | `claim_doc`, `release_doc` |
| Todos | `list_todos`, `create_todo`, `update_todo`, `set_todo_status` |
| History | `list_versions`, `create_branch`, `delete_branch`, `switch_branch`, `merge_branch`, `restore_revision` |
| Reflex | `jev_profile`, `memory_map`, `jev_activity`, `brain_inbox`, `jev_do`, `jev_job`, `jev_resolve`, `jev_undo`, `jev_configure` |
| Presentation | `show_doc_on_canvas`, `show_group_on_canvas`, `draw_research_canvas` |

`jev_job` returns a job and its durable document progress. Its optional typed `action` selects on-demand inspection of one current decision and its source evidence. Job inspection follows the same canvas and tool grants; workspace progress aggregates remain available to the owner API.

Symbi also receives tools from two other sources:

| Source | Count | Tools | Authority |
| --- | --- | --- | --- |
| Deep Agents runtime | 8 with current Symbi wiring | `task`, `ls`, `read_file`, `write_file`, `edit_file`, `delete`, `glob`, `grep` | Delegation and files inside Symbi's conversation workspace |
| Configured external MCP servers | Varies by live discovery | Names returned by each server's live discovery | That server's configured credentials and permissions |

The application does not add a separate hardcoded set of shared-document agent tools. Installed Deep Agents 1.14.1 supplies these eight through Symbi's `ChatOpenAI` and `FilesystemBackend` configuration. Other harness configurations can add `write_todos`. Deep Agents' `execute` tool requires an execution-capable backend; Symbi's configured `FilesystemBackend` supplies file operations. `create_doc`, `edit_doc`, and `import_documents` were replaced by the explicit file upload modes. `jev_propose` was removed in favor of `jev_do`.

### Agent file workflow

1. Discover sources with `ask_symbi`, `search_docs`, or canvas/document reads.
2. Claim a long-running edit with `claim_doc`.
3. Call `download_file` with `canvasId`, `blockId`, and optional `branch`. Save the returned source and working-copy manifest in the agent's environment.
4. Edit the local file using the agent's own editor, filesystem tools, or shell.
5. Call `upload_file` with `mode: "replace"`, the original `checkoutId`, edited file bytes, filename, and an `idempotencyKey`. The server validates the authoritative checkout and current version, then returns a durable receipt.
6. Read back the saved result and release the lock.

An HTTP client materializes files locally and uploads their bytes; server paths are never client paths. Stdio additionally accepts local `destinationPath` and `sourcePath`. Symbi's adapter manages files inside its persistent conversation directory.

`download_file` returns `{ manifest, content, filename }`. The manifest binds the working file to its caller, workspace, canvas, document incarnation, branch, loader, base hash, and base revision. Exports use format-aware filenames. Website sources are `.symbi-site.json` packages containing `documentContent` and source files.

`upload_file` has explicit modes: `create` makes a document; `replace` commits an edited checkout; `propose` submits an edited checkout for review. It returns `{ operationId, mode, canvasId, blockId, branch, contentHash, revision, kind, filename, title, savedAt, proposalId? }`. Repeating the same key and payload returns the same receipt. Reusing a key with different bytes fails. Replacement preserves the document's identity and format unless an authorized conversion is explicitly requested.

A stale version fails with `409`; keep the edited file, download the current source, merge locally, and upload using a fresh checkout. Branch downloads and uploads leave the shared visible branch unchanged. `switch_branch` explicitly changes the shared visible branch for everyone.

Direct agent content-edit tools are absent. Metadata and task operations remain typed MCP tools.

## HTTP API

All JSON routes live under `/api` and return `{ "error": "…" }` on failure. Bodies must be `application/json` (`415` otherwise). With an access token configured, every route except `/session` needs the session cookie or `Authorization: Bearer <access token>`. Send `x-symbiknow-actor: <name>` to name the author.

### Workspaces and canvases

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/workspaces` | Add `?stats=1` for document counts and update times |
| POST | `/workspaces` · `DELETE /workspaces/:id` | Create or permanently delete |
| POST | `/workspaces/:id/canvases` | Create a canvas |
| GET | `/canvases/:id` | Full canvas (ETag); `?summary=1` without bodies; `?includeContent=false&limit=&cursor=` pages metadata |
| DELETE | `/canvases/:id` | Deletes documents, histories, inbound links |
| PUT | `/canvases/:id/layout` | Positions and groups in one write |

### Documents

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/canvases/:id/blocks` | Create `{ title, kind?, content?, x?, y? }` |
| POST | `/canvases/:id/imports` | 1–20 documents with idempotency keys |
| GET | `/canvases/:id/blocks/:blockId` | One document with content and hash; `?branch=` reads a branch |
| PUT | `/canvases/:id/blocks/:blockId` | Partial update with guards; `?branch=` edits a branch |
| DELETE | `/canvases/:id/blocks/:blockId` | Optional preconditions body |
| POST | `/canvases/:id/blocks/:blockId/move` | Move to another canvas in the workspace |
| POST | `/canvases/:id/links` | `{ fromBlockId, toBlockId, action: "link" \| "unlink" }` |
| POST/DELETE | `/canvases/:id/blocks/:blockId/lock` | Claim or release (`?force=1`) |
| GET | `/canvases/:id/blocks/:blockId/download` | Raw `.md` |
| GET/POST/DELETE | `/canvases/:id/blocks/:blockId/versions…` | `versions`, `/preview`, `/branches`, `/branches/:name`, `/switch`, `/merge`, `/restore` |

### Search, chat, settings, brain

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/search?q=&canvasId=&limit=&cursor=` | Local search, no provider calls |
| POST | `/chat/stream` | SSE chat stream (see [Assistant](assistant-and-research.md)) |
| GET/POST | `/chat/proposals/:id` · `/apply` · `/undo` | Review chat proposals |
| GET/PATCH/DELETE | `/investigations/:id` | Saved research sessions |
| GET/PUT | `/settings` | Never returns secrets |
| GET | `/models?provider=` | Provider model list |
| POST/DELETE | `/mcp/tokens` · `/mcp/tokens/:id` | Create or revoke tokens |
| GET | `/mcp/info` | Endpoint, public URL, protection, sessions |
| POST | `/mcp/servers/test` | Test an external MCP server |
| GET/POST/DELETE | `/session` | Browser sign-in |
| POST | `/symbi/ask` · `/symbi/reflex` | Brain tools |
| * | `/workspaces/:id/jev/*`, `/canvases/:id/jev/*` | Symbi Reflex (see [Symbi Reflex](symbi-reflex.md)) |

### curl examples

```sh
export API=http://127.0.0.1:8787/api AUTH="Authorization: Bearer $SYMBIKNOW_ACCESS_TOKEN"

# compact canvas view
curl -s -H "$AUTH" "$API/canvases/$CANVAS?includeContent=false&limit=50"

# create a document
curl -s -H "$AUTH" -H 'content-type: application/json' -H 'x-symbiknow-actor: Script' \
  -d '{"title":"Release plan","content":"# Release plan\n"}' "$API/canvases/$CANVAS/blocks"

# safe edit
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' \
  -d '{"content":"# Release plan\n\nShip Friday.","expectedContentHash":"3f9a1c0b7d2e4a51","message":"Set date"}' \
  "$API/canvases/$CANVAS/blocks/$BLOCK"

# ask Symbi
curl -s -H "$AUTH" -H 'content-type: application/json' \
  -d '{"question":"Which documents explain the release process?","mode":"semantic"}' "$API/symbi/ask"
```

## Adding a new MCP tool

1. Add the authoritative API handler when the operation accesses shared state.
2. Register the tool in its owning `server/mcp-*-tools.ts` module with a Zod schema, an accurate description, and permission metadata. Use `annotations.readOnlyHint: true` for reads or `_meta.permission` for proposal, approval, and configuration grants.
3. Include a new registrar in `server/mcp-registry.ts` when needed. Discovery, Settings validation, and audit policy derive from these registrations.
4. Verify authorization both at MCP execution and at the underlying API boundary; canvas scope must apply before search pagination.
5. Test real MCP calls, durable save/read-back, conflicts, restricted callers, and relevant transport behavior.
