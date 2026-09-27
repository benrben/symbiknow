# SymbiKnow API contract

All JSON endpoints use `/api` and return `{ error: string }` on failure. Request bodies must be sent as `application/json` (other types get `415`), and writes from a sandboxed document (`Origin: null`) get `403`. When `SYMBIKNOW_ACCESS_TOKEN` or the legacy `ALLTEAM_ACCESS_TOKEN` is set, every route except `/session` needs the session cookie or `Authorization: Bearer <access token>` (`401` otherwise). If both variables are set, either token is accepted and existing cookies stay valid while their token remains configured.

Send `x-symbiknow-actor: <name>` to name the author of document revisions, locks, and tasks. The browser sends `Browser`; MCP agents send their client name plus token name. The legacy `x-allteam-actor` header, `allteam_session` cookie, and `ALLTEAM_*` environment aliases remain supported for existing integrations. New browser sessions use `symbiknow_session`.

| Method | Path | Input | Output |
| --- | --- | --- | --- |
| GET | `/workspaces` | — | `WorkspaceSummary[]` |
| POST | `/workspaces` | `{ name }` | `WorkspaceSummary` |
| GET | `/canvases/:canvasId` | — | `CanvasDocument` |
| POST | `/canvases/:canvasId/insights` | `{ query: string }` | `InsightReport` |
| POST | `/canvases/:canvasId/insights/feedback` | `{ itemId, category, confidence: 0–1, decision: 'applied' \| 'dismissed' }` | `{ itemId, category, confidence, decision, at }` |
| GET | `/settings/jev-feedback` | — | `{ category, bucket, applied, dismissed, applyRate }[]` |
| POST | `/canvases/:canvasId/automations` | `{ kind: 'regroup' \| 'layout' \| 'connection' \| 'purpose' \| 'work_area' \| 'reviewer', groupBy?: 'work_area' \| 'purpose' \| 'lane' }` | `{ kind, applied, groupBy?, groups?: { key, count }[] }` |
| PUT | `/canvases/:canvasId/layout` | `{ positions: { blockId, x, y, group?: string \| null }[] }` | `CanvasDocument` |
| POST | `/workspaces/:workspaceId/canvases` | `{ name }` | `CanvasDocument` |
| POST | `/canvases/:canvasId/blocks` | `{ title, kind?, content?, x?, y? }` | `CanvasBlock` |
| PUT | `/canvases/:canvasId/blocks/:blockId` | Partial `CanvasBlock`, plus optional `expectedContentHash` (`409` if the file changed) and `message` (revision message) | `CanvasBlock`; `423` if another actor holds the lock and the change touches content, title, or loader |
| POST | `/canvases/:canvasId/blocks/:blockId/lock` | `{ ttlSeconds?: 30–3600, note?, force? }` | `{ owner, expiresAt, note? }`; `409` if held by another actor |
| DELETE | `/canvases/:canvasId/blocks/:blockId/lock[?force=1]` | — | `{ ok: true }` |
| GET | `/canvases/:canvasId/tasks` | — | `CanvasTask[]` |
| POST | `/canvases/:canvasId/tasks` | `{ title, detail?, status?, assignee?, blockIds? }` | `CanvasTask` |
| PUT | `/canvases/:canvasId/tasks/:taskId` | Partial `{ title, detail, status, assignee (null clears), blockIds }` | `CanvasTask` |
| DELETE | `/canvases/:canvasId/tasks/:taskId` | — | `{ ok: true }` |
| POST | `/canvases/:canvasId/tasks/:taskId/claim` | `{ force? }` | `CanvasTask`; `409` if another actor claimed it |
| POST | `/canvases/:canvasId/tasks/:taskId/comments` | `{ text }` | `CanvasTask` |
| DELETE | `/canvases/:canvasId/blocks/:blockId` | — | `{ ok: true }` |
| GET | `/canvases/:canvasId/blocks/:blockId/download` | — | Raw `.md` attachment |
| GET | `/canvases/:canvasId/blocks/:blockId/versions` | — | `{ current, branches, commits }` for one file |
| POST | `/canvases/:canvasId/blocks/:blockId/versions/branches` | `{ name }` | Updated file version status |
| POST | `/canvases/:canvasId/blocks/:blockId/versions/switch` | `{ name }` | Updated file version status |
| POST | `/canvases/:canvasId/blocks/:blockId/versions/merge` | `{ name }` | Updated file version status; `409` on conflict |
| POST | `/canvases/:canvasId/blocks/:blockId/versions/restore` | `{ revision }` | Updated file version status with a new restore commit |
| GET | `/search?q=...` | — | `{ canvasId, blockId, title, excerpt }[]` |
| GET | `/settings` | — | `ChatSettings` (never includes keys, secret values, or token values) |
| PUT | `/settings` | `{ provider?, model?, baseUrl?, apiKey? (for the selected provider), providerKeys?, systemPrompt?, reviewers?, workAreas?, agentProfile?, customProfiles?, agentPlugins?, secrets?: { NAME: value \| null }, mcpServers?, groupBy?, jevApiKey?, jevPolicy?: Partial<Record<ActionKind, { show, apply }>> }` | `ChatSettings` |
| GET | `/jev/usage` | — | `{ model, month: JevUsageTotals, today: JevUsageTotals }`, each totals object `{ requests, questions, inputTokens, outputTokens, estimatedCostUsd }` |
| GET | `/jev/calibration` | — | `{ kind, suggestedShow: number \| null, sampleSize, note? }[]`, one entry per policy control with reviewed suggestion feedback |
| GET | `/models?provider=` | — | `{ id, name, tools?, context? }[]` from the provider |
| POST | `/mcp/servers/test` | `{ url, name?, bearerSecret?, headers? }` | `{ ok, server, tools: { name, description }[] }` |
| GET | `/mcp/info` | — | `{ origin, endpoint, publicUrlConfigured, accessProtected, activeSessions }` |
| POST | `/mcp/tokens` | `{ name }` | `{ token, settings }` — the token is shown only here |
| DELETE | `/mcp/tokens/:id` | — | `ChatSettings` |
| GET / POST / DELETE | `/session` | POST `{ token }` | `{ authRequired, authenticated }`; POST sets the session cookie |
| POST | `/chat` | `{ canvasId, messages: ChatMessage[] }` | `ChatReply` |
| POST | `/chat/stream` | `{ canvasId, messages: OpenAI chat messages[] }` | OpenAI Chat Completions SSE stream of live tokens, plus `agent_step` (tool activity), `answer_reset` (text so far was a note before a tool call), `verification` (`{ status: 'checking' \| 'supported' \| 'unsupported' \| 'unavailable', score? }`), and `error` (`{ message }`) events; validation errors are JSON |

Jev requests use a pinned model, `jev-1.13.0` by default (override with `TYPESAFE_MODEL`), retry once on a `429` or `529` response honoring `Retry-After`, and are validated locally before sending: question ids, option counts, and a combined state-plus-question size under 32,000 estimated tokens, else `413` without calling Jev. Noul questions use `true`/`false` criteria keys. Each `ActionKind` in `ChatSettings.jevPolicy` has one scale, a Noul probability or a Choice/Score confidence; the newer kinds are `tag`, `merge_safe`, `stale`, `steps`, `conflict`, `gap`, `reflected`, `layout`, `move`, and `route`. Duplicate, cross-canvas, and tag suggestions send one Jev request per document or pair. `GET /jev/usage` appends each call's usage under `DATA_DIR/jev-usage/<YYYY-MM>.jsonl` and totals this month and today; `GET /jev/calibration` aggregates reviewed suggestion feedback (`POST /canvases/:canvasId/insights/feedback`) into a suggested Show threshold per policy kind, requiring at least 20 decisions at or above a 60% apply rate.

The server owns `.md` files and the canvas layout. The browser receives file contents through the API and does not receive saved API keys. A `website` block's Markdown contains frontmatter with `generator` and `source` fields; the site preview loader requests its build through a dedicated server route.

Each document has a separate Git repository under `DATA_DIR/.versions/<block-id>`. Source changes create revisions for that file. Branch switching, merging, and restoring copy only that file's source back to its Markdown document. Canvas layout and other documents are unaffected. The stdio project MCP server uses this API as its shared writer; WebMCP tools call the same API from the browser.

`CanvasBlock` can include `group` (`lane:…`, `area:…`, or `purpose:…`; older bare lane names still work), `purpose`, `workArea`, and `reviewer` labels, and responses add `contentHash` and any active `lock`. `ChatSettings.reviewers` and `ChatSettings.workAreas` are comma-separated lists used for Jev reviewer and custom work-area choices. `agentProfile` selects General, Researcher, Planner, or Builder instructions; `agentPlugins` selects the `document_read`, `document_write`, and `jev_insights` chat tool packs. The settings response includes `hasApiKey` for OpenRouter chat and `hasJevApiKey` for the direct TypeSafe Jev API; neither saved key is returned. The Insights route returns reading order and relevance rankings plus categorized suggestions with confidence values and optional `link`, `unlink`, `update`, or `layout` actions. Reading-order entries include Jev's `lane` choice. It requires a saved TypeSafe Jev key or `TYPESAFE_API_KEY` for nonempty canvases, analyzes every block in concurrent batches of 12, and checks selected pairs, including every saved edge, in concurrent batches of 18. It never applies suggestions itself. The UI's canvas-wide buttons call the automations route, which asks Jev only the questions that automation needs (for example, only reviewer questions for reviewers, or only reading order and the grouping label for layout, reusing saved labels) and saves the eligible changes. The report's `classification` lists each document's lane, work area, and purpose with confidence. Layout updates validate all positions before saving them together. Chat streaming uses the provider selected in Settings (OpenRouter, OpenAI, Anthropic, or an OpenAI-compatible server) and TypeSafe Jev for routing, protected-change checks, and answer verification. Deep Agent automation tools require Jev to confirm that the latest user request explicitly asked for the change.

## MCP over HTTP

`/mcp` (outside `/api`) is a Streamable HTTP MCP endpoint with sessions. Authenticate with `Authorization: Bearer <MCP token>` or use `/mcp/t/<token>` for clients that cannot send headers. Tokens come from `POST /api/mcp/tokens`, `SYMBIKNOW_MCP_TOKEN`, or either configured access token. The older `ALLTEAM_MCP_TOKEN` remains accepted. The tools match the stdio server except that `upload_file` and `download_file` take and return complete content only, never server file paths.
