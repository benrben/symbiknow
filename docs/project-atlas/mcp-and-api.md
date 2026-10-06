# MCP and API

How agents connect, which tools they get, how tokens are scoped, and the HTTP API every client uses underneath.

## Three ways for an agent to connect

| Transport | Where | Notes |
| --- | --- | --- |
| Streamable HTTP | `<PUBLIC_URL>/mcp` with `Authorization: Bearer <token>` | Recommended for Claude Code, Codex, Cursor, remote agents |
| Token-in-path | `<PUBLIC_URL>/mcp/t/<token>` | For Claude.ai / Claude Desktop custom connectors that cannot send headers; treat the URL as a secret |
| stdio | `npm run mcp` (`server/mcp.ts`) | Same machine only; reads `CANVAS_API_URL`; `upload_file`/`download_file` can use local paths |
| WebMCP | Browser tab + `./node_modules/.bin/webmcp --mcp` | Drives the open page; token pasted into the canvas widget |

Every MCP tool is a thin wrapper that calls the HTTP API (`server/mcp-api.ts` → `CanvasApi`). The actor header is the client name plus the token name, such as `Claude Code - laptop`, so revisions stay attributable.

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

Existing configs named `allteam-canvas` keep working.

## Tokens and scopes

Create tokens in **Settings → MCP connections**. They are stored hashed, show last use, and can be revoked. Each token can be limited:

| Scope | Values | Effect |
| --- | --- | --- |
| `access` | `read`, `propose`, `write` | `read` sees only readable tools; `propose` adds `jev_propose`; `write` gets everything |
| `allowedCanvasIds` | list of canvas ids | Results are filtered to these canvases; calls outside them fail |
| `tools` | list of tool names | Only these tools are registered for the session |

Unscoped tokens also come from `SYMBIKNOW_MCP_TOKEN` or the access token. Old `ALLTEAM_*` variables still work.

## Default tool catalog

| Group | Tools | Notes (new behavior marked) |
| --- | --- | --- |
| Find | `list_canvases`, `read_canvas`, `search_docs`, `read_doc` | `list_canvases` includes counts and update time. `read_canvas` supports `includeContent: false` and `limit`/`cursor` (new). `search_docs` supports `canvasId`, `limit`, `cursor` (new). `read_doc` supports `branch` (new) |
| Write | `create_doc`, `edit_doc`, `delete_doc`, `upload_file`, `download_file` | Hash required for edit, replace, and delete (new). HTML documents report `kind: "html"` (new) |
| Arrange | `move_block`, `link_blocks`, `unlink_blocks` | Links change in one atomic `POST /canvases/:id/links` (new) |
| Coordinate | `claim_doc`, `release_doc` | Locks of 30–3600 s |
| Tasks | `list_tasks`, `create_task`, `update_task`, `delete_task`, `claim_task`, `comment_task` | `list_tasks` filters by `status`/`assignee` with pages (new); `boardOrder`; `delete_task` with `expectedRevision` and an audit record (new) |
| History | `list_versions`, `create_branch`, `delete_branch`, `switch_branch`, `merge_branch`, `restore_revision` | `delete_branch` new; `list_versions` pages (new); `switch_branch` is a legacy shared switch |
| Brain | `ask_symbi`, `symbi_reflex` | New default brain tools, see [Search and brain tools](search-and-brain-tools.md) |

**Legacy Jev tools**: `jev_profile`, `find_by`, `related`, `memory_map`, `jev_activity`, `brain_inbox`, `jev_do`, `jev_propose`, `jev_job`. These are no longer registered by default. They appear when `SYMBIKNOW_LEGACY_BRAIN_TOOLS=1` is set, when the server option `legacyBrainTools` is on, or when a token's tool list names one. Their filter fixes (LEG-01 to LEG-09) are still open.

### The recommended agent workflow

1. `list_canvases`, then `read_canvas` with `includeContent: false`, or `ask_symbi` / `search_docs` to find documents.
2. `read_doc` to get the full source and `contentHash`.
3. `claim_doc` before a long edit.
4. `edit_doc` or `upload_file` with `expectedContentHash`. On `409`, reread and merge.
5. `release_doc`; coordinate with `list_tasks`, `claim_task`, `comment_task`, `update_task`.

## HTTP API

All JSON routes live under `/api` and return `{ "error": "…" }` on failure. Bodies must be `application/json` (`415` otherwise). With an access token configured, every route except `/session` needs the session cookie or `Authorization: Bearer <access token>`. Send `x-symbiknow-actor: <name>` to name the author.

### Workspaces and canvases

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/workspaces` | Add `?stats=1` for document counts and update times |
| POST | `/workspaces` · `DELETE /workspaces/:id` | Create or permanently delete |
| POST | `/workspaces/:id/canvases` | Create a canvas |
| GET | `/canvases/:id` | Full canvas (ETag); `?summary=1` without bodies; `?includeContent=false&limit=&cursor=` pages metadata |
| DELETE | `/canvases/:id` | Deletes documents, tasks, histories, inbound links |
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

### Tasks, search, chat, settings, brain

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/canvases/:id/tasks` | Filters: `status`, `assignee`, `limit`, `cursor` |
| PUT/DELETE | `/canvases/:id/tasks/:taskId` | `expectedRevision` guard |
| POST | `/canvases/:id/tasks/:taskId/claim` · `/comments` | Claim or comment |
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

1. Add the HTTP route first (`server/api-*.ts`) so the browser, WebMCP, and MCP share one implementation.
2. Register the tool in `server/mcp-tools.ts` (or `mcp-brain-tools.ts`) with a zod `inputSchema` and a description that says what it changes.
3. If it only reads, add it to `readableMcpTools` in `server/settings.ts` so read tokens can use it; check `scopedResult` filtering in `server/mcp-scope.ts`.
4. Mirror it in WebMCP (`src/webmcp*.ts`) if the browser tab should expose it.
5. Test in `server/mcp-tools.test.ts` (request contract) and `server/mcp.test.ts` / `server/collaboration.test.ts` (end to end).
