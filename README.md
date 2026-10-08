# SymbiKnow

**Make knowledge together.** SymbiKnow is an infinite canvas where people and AI organize ideas and build knowledge together. Spread documents across the canvas, connect related work, and see who contributed and what changed. People work in the browser; AI agents join through the assistant or MCP.



https://github.com/user-attachments/assets/5ee3e2dc-f1d4-4a9a-8868-2f70ed5c20d2


*One minute: teams and their agents share documents, and every change stays named and restorable.*

This is the source repository for [SymbiKnow](https://github.com/benrben/symbiknow). It is public for viewing; the original source and brand assets are [all rights reserved](LICENSE). Third-party packages and fonts keep their own licenses.

Each card keeps its source in a separate `.md` file. The canvas stores positions, sizes, groups, and links, while each document has reviewable Git history. The browser renders Markdown, Mermaid, code, slides, media, MDX, and websites. Both light and dark mode are supported.

The [brand guide](brand/symbiknow-brand-guide.md) explains the identity, voice, and product promise. [Light](brand/symbiknow-identity-board.png) and [dark](brand/symbiknow-identity-board-dark.png) identity boards show the visual direction.

## Loaders and libraries

| Content in a block | Library or tool |
| --- | --- |
| Markdown, tables, task lists, links, and safe inline HTML | `react-markdown`, `remark-gfm`, `rehype-raw`, `rehype-sanitize` |
| Syntax highlighted code fences | `shiki` |
| Mermaid diagrams | `mermaid` |
| Slide decks in Markdown | `@marp-team/marp-core` |
| Direct `.mp4`, `.webm`, and `.ogg` links | Native HTML `<video>` |
| YouTube and Vimeo links | `react-player` |
| Checkboxes saved to their `.md` file | `unified`, `remark-parse`, `remark-gfm`, `remark-stringify` |
| Live MDX components | `@mdx-js/mdx` with the React JSX runtime; `@mdx-js/react` is available for provider based components |
| Full documentation websites | MkDocs, Hugo, or Docusaurus, installed separately for the selected site |
| Infinite canvas and connections | `@xyflow/react` |
| WebMCP tools | Pinned `@jason.today/webmcp@0.1.13` client from webmcp.dev |

MDX blocks allow the included `Calculator` and `Chart` components. Imports, arbitrary JavaScript expressions, and unknown components are rejected. The included chart uses CSS bars. Website blocks point to a source folder and use the named generator; their canvas previews are static, while **Open site** serves the complete generated website.

**Upload files** accepts `.md`, `.mdx`, and `.html`. A full HTML file is saved as a Markdown document with `format: html` frontmatter. It runs as an interactive page (scripts, forms, and popups work) inside a sandbox without `allow-same-origin`, so it cannot read the app's cookies, storage, or API responses, and the server rejects writes from it. Three self-contained HTML examples are in [`examples/html`](examples/html).

The document editor uses CodeMirror with Markdown or HTML highlighting. The **Source / Split / Preview** switch (⌘E / Ctrl+E) renders unsaved changes. **Download .md** gets the source, and **Upload edited file** replaces it after local editing. If another person or agent changed the file since you opened it, saving is refused instead of overwriting their edit.

Use the **↗ Open full page** button on any canvas card to read the complete document; uploaded HTML grows to its full height. Each open document has its own URL (`?canvas=…&doc=…`), so it can be linked, and the browser **Back** button, **← Back to canvas**, and Esc all return to the same canvas view. The previous/next buttons, the document list, the ← and → keys, and the links at the end of the page move through the canvas in reading order.

Markdown documents support Hebrew, Arabic, and mixed RTL/LTR text automatically in canvas cards, the full-page reader, search previews, and the source editor. Each paragraph, heading, list, and table cell chooses its own direction. Code stays left-to-right. Explicit HTML `dir="rtl"` or `dir="ltr"` sections in Markdown are respected.

Each canvas also has a **Tasks** view. Add work, switch between list and board layouts, and sort by priority, due date, size, or newest. Completing a task moves it to **Archive** automatically; restore it to reopen the work. MCP agents can use `list_todos`, `create_todo`, `update_todo`, and `set_todo_status` to manage the same saved tasks. See the [task guide](docs/todos.md).

## Run locally

Use Node.js 20.19+ or 22.12+ and npm. The tested release environment uses Node.js 24.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. For a production build:

```sh
npm run build
npm start
```

The server listens on `PORT` (default `8787`) and stores content under `DATA_DIR` (default `./data`). The app creates an example workspace on first run.

The React client is in `src/`, the API and storage code in `server/`, shared types in `shared/`, and browser acceptance scenarios in `features/`. Start with the [documentation index](docs/README.md) for architecture and operations. `data/`, `dist/`, `node_modules/`, `work/`, and generated quality reports are local artifacts excluded from Git. The old implementation plans in `docs/plans/` describe historical work; use this README and [API.md](API.md) for the current feature set.

The repository includes [example environment settings](.env.example). Supply them through your shell or deployment platform; the app does not load `.env` automatically. Keep real keys and `DATA_DIR` out of Git. Run `npm run lint`, `npm run typecheck`, `npm test`, and `npx cucumber-js` before committing a change; `npm test` builds the app before testing, and [CI](.github/workflows/ci.yml) runs the same checks on pushes and pull requests.

## Self-hosting

Run the production server on your host and put it behind HTTPS (a reverse proxy such as Caddy, nginx, or your platform's load balancer):

| Variable | Purpose |
| --- | --- |
| `HOST` | Interface to bind. Default `127.0.0.1`; use `0.0.0.0` behind a proxy or in a container. |
| `PORT`, `DATA_DIR` | Port and content folder. Keep `DATA_DIR` on persistent storage. |
| `PUBLIC_URL` | The address people and agents use, such as `https://symbiknow.example.com`. Settings shows MCP connection details for this address. |
| `SYMBIKNOW_ACCESS_TOKEN` | Protects the workspace. Browsers sign in once (HTTP-only session cookie); scripts can send `Authorization: Bearer <token>`. Set this whenever the server is reachable from other machines. |
| `SYMBIKNOW_MCP_TOKEN` | Optional fixed MCP token for automated deployments. Tokens created in Settings work too. |
| `SYMBIKNOW_AGENT_NAME` | Optional author name for a local stdio MCP agent. The sample Claude Code and Codex configs set this explicitly. |
| `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Optional environment fallbacks for keys saved in Settings. |

The older `ALLTEAM_ACCESS_TOKEN`, `ALLTEAM_MCP_TOKEN`, and `ALLTEAM_AGENT_NAME` names still work. If both access-token names are set, both tokens and their existing browser sessions remain valid; new browser sessions use `SYMBIKNOW_ACCESS_TOKEN`. Both fixed MCP tokens are accepted. The new agent-name variable takes precedence when both are set. New clients use the `symbiknow_session` cookie and `x-symbiknow-actor` header; the older cookie and header still work for existing sessions and integrations. Stored IDs and workspace data are unchanged. Existing MCP config entries named `allteam-canvas` still connect; `symbiknow` is the new example name. The server warns at startup if `HOST` exposes the canvas without an access token. Request bodies must be JSON, which blocks cross-site form posts.

## Revision history and branches

Each document has its own local Git history under `DATA_DIR/.versions/<block-id>`. Saving that document's source creates a revision whose author is whoever made the change: `Browser`, the chat assistant `Symbi`, or an MCP agent such as `Claude Code - <token name>` or `Codex - <token name>`. Existing revision authors keep their original names, including older `Jev` and `SymbiKnow assistant` entries. Open **File history** on a canvas card or in its full-page reader to see authors and commits, create or switch branches, merge another branch, and restore an older revision as a new commit. These actions change only that document file; canvas positions, links, and other documents stay in place. A conflicting merge is aborted and leaves the file unchanged. Deleting a document records who deleted it as a final commit, and the last content stays in that history for recovery. Settings and API credentials are never added to the document repositories.

To remove an entire canvas, use the trash button beside its name in the workspace sidebar and confirm. This permanently deletes that canvas's documents and file histories, removes links to it from other canvases, and opens another canvas in the workspace. If it was the last canvas, create a new one from the empty state.

To remove a workspace, use the trash button beside its name and confirm. This permanently deletes every canvas in that workspace with their documents and file histories. The app opens a surviving workspace, or offers to create one if none remain.

## Symbi, the assistant

The **04 Ribbon** icon is the SymbiKnow project mark, used in the app chrome, favicon, and wordmark. **Symbi** is the chat guide: a living inner companion in a fluid glass bubble. Its 16 poses follow actual activity, with gentle movement even at rest. Chat has one 56px avatar in its header. **Symbi Reflex**, the organizer and planner, uses the same artwork with its own activity state. Both support light and dark themes; motion stops when the user prefers reduced motion.

Open the [interactive Symbi preview](brand/symbi-avatar-demo.html) to try its conversation and motion states. See the [dark](brand/symbi-avatar-preview-dark.png) and [light](brand/symbi-avatar-preview-light.png) captures for a quick look. The preview uses scripted sample answers; the app uses the configured chat model and canvas tools.

Open **Settings** (one page with a section list): **Models**, **Agents**, **Secrets**, **MCP servers**, **MCP connections**, **Plugins & loaders**.

- **Models:** choose OpenRouter, OpenAI, Anthropic (through its OpenAI-compatible endpoint), or any OpenAI-compatible server such as Ollama or vLLM. Each provider keeps its own key. **Browse models** lists the provider's current models with tool-calling and context badges.
- **Agents:** pick a built-in profile (General, Researcher, Planner, Builder) or add your own profiles with custom instructions.
- **Secrets:** named values such as `GITHUB_TOKEN`. They stay on the server and are never returned to the browser.
- **MCP servers:** connect outside Streamable HTTP or SSE MCP servers so the chat agent can use their tools. Authenticate with a saved secret (`Bearer <secret>`) or `${secret:NAME}` in a header, and use **Test** to list a server's tools.
- **Plugins:** turn tool packs on or off for the chat agent: reading, editing, and outside MCP tools.

The assistant uses [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview) for tools and [AI Elements](https://docs.langchain.com/oss/python/langchain/frontend/integrations/ai-elements) for the chat interface. Answers stream token by token. Text the model writes before calling a tool moves into the collapsible activity list, so the final answer stays clean. **Copy** copies the Markdown answer. **New chat** clears the conversation. Drag the left edge of the chat panel to resize it; the width is saved locally. A run can make up to 9,999 tool calls; cancellation and provider errors still stop it.

## Research canvas and view-aware chat

The assistant knows the canvas, group, document, selection, or research block currently in view. The **Using** control below chat lets you choose **Current view**, **Whole canvas**, **Selected documents**, or **Research canvas** when available. Suggested questions change with that focus. Ask it to open a relevant document or group and it can take you there; the chat keeps a return action, and **Research canvas** in the chat header reopens the session's map after you move elsewhere.

Ask directly to create a temporary research canvas or answer briefly in chat. Source context and layout are selected locally; the configured chat model writes and draws the answer.

The research canvas keeps growing across follow-up questions in the same chat. Its compact two-row header keeps outline and sources in popovers, and the temporary canvas shows documents and connections without group frames or grouping controls. The agent can add connected Markdown, diagrams, tasks, slides, HTML, or supported MDX blocks, and cite selected source documents inside the blocks. Sources are links to the original documents, rather than extra evidence cards. Pick **Roadmap**, **Kanban**, **Architecture**, or **Mind map** under **View & export**. You can pan, zoom, search, read, edit, add, move, connect, upload, and undo in the same canvas UI; its focus and suggested follow-ups change as you zoom or select a block. **Save canvas** creates a regular workspace canvas with its blocks and links; **Export Markdown** downloads a readable copy. Unsaved research is retained in this browser across reloads and is cleared by **New chat**. See the [research canvas guide](docs/research-canvas.md) for the full workflow.

## Symbi Reflex, the automatic organizer

Symbi Reflex runs six actions automatically: understand documents, organize groups, suggest labels, find a home canvas, find connections, and compare duplicates. Saved sources and workspace changes trigger the workflow; no request, mode selection, or approval is required. Removed actions remain readable in historical activity and available for checked Undo.

Open the **Symbi Reflex** tab beside Chat to set one confidence threshold per action and view progress, findings, saved activity, and source evidence. Thresholds save automatically, default to 70%, and accept 50–100%. Raising a threshold makes that action more selective; changing it refreshes the affected automatic checks. A saved or environment `TYPESAFE_API_KEY` starts processing automatically, including existing documents. Add a missing key in ordinary Settings. Chat has separate model credentials.

Workspace owners can use **Reset and rerun Jev** in that tab to clear Jev-generated analysis and organization across every canvas and start all six actions again. Manual metadata, source content, positions, thresholds, and provider credentials remain. Reset resumes automatic processing and requires a connected provider. A durable cleanup journal recovers interrupted resets before processing continues.

Canvas and Reflex loading use lightweight summaries. Source content loads when a document opens; saved analysis loads when its details expand. Background polls share an in-flight request and preserve unchanged canvas objects. Reflex reads do not wait for the processing queue. Progress and queue reads reuse bounded projections, checking the current file's SHA-256 digest to detect outside changes. Jev shares bounded provider requests for the six retained actions, caches parsed source passages within a memory budget, and combines upload bursts into a scan plus a trailing scan. Document plans share context while preserving separate checked results. Group selection and evidence selection precede validation of the selected group. Labels reuse existing tags or label definitions, with source headings and repeated categories as fallback candidates for fresh workspaces; this does not maintain a vocabulary. Shared grouping and relationship changes remain coordinated. Checks that depend on earlier decisions still run in order. Maintenance plans from one ledger and organization snapshot per pass; the next pass reads fresh inputs. Each source guard reads a canvas once per invocation while still checking every selected source. Topic ranks and neighbor query terms are computed once before sorting or scoring. Durable processing history pools repeated source metadata and canvas blocks in saved Undo proofs without discarding results or recovery evidence. Legacy ledgers remain readable; each restored proof owns independent objects and retains its exact saved values.

Source evidence and current revisions guard every save. Manual classifications and assignments remain authoritative; unsupported changes are skipped with a reason. Duplicate assessments are saved findings and do not merge documents. Below-threshold classifications remain unknown. Known people can help identify meaningful mentions in document profiles. Historical findings from removed actions remain readable and undoable.

Organization fingerprints distinguish trusted automatic output from manual inputs, and admission checks pending work inside the workspace queue to prevent duplicate chains. Follow-up metadata saves with the initial job; results without proposals complete in one checked write. Maintenance and cold progress reads avoid expanding discarded history, while canonical execution retains full validation. The requested latency for all six actions is not yet verified; dependent provider calls remain part of the measured latency.

Automatic document profiling shares bounded question rounds across the six actions. Grouping consumes only the selected group's exact-passage purpose and containment checks, plus coherence validation for new groups. Repeated sources and question text share scoped transport references; automatic bundles obey the SDK state-plus-longest-question budget. A private, short-lived cache reuses validated answers for each original set. Keys include exact inputs, provider, authorization, policy, and scoped source identities. Later actions build proposals from current documents and retain source, ownership, and revision checks. Changed inputs require fresh questions; reset, closure, and changed transport clear the cache.

Symbi and MCP agents use the same scoped jobs. Agents cannot approve their own proposals; the workspace background workflow independently performs the enabled automatic work. Historical receipts remain available for checked Undo. The reusable Jev engine and typed SDK are unchanged: `npm run build:sdk` emits `dist/sdk/sdk.js` and its declarations. See the [engine guide](docs/jev/README.md) and [current action contract](docs/jev/decision-contract.md).

## Website blocks

A website block is a Markdown descriptor pointing to a source directory under `DATA_DIR`. Its frontmatter selects `docusaurus`, `hugo`, or `mkdocs` and a source path. The matching generator must be installed for previews. The canvas displays the generated site in the block. The sample workspace uses MkDocs, which can be installed with the commands below. Hugo requires its `hugo` executable, and Docusaurus requires the selected site's own `node_modules/.bin/docusaurus` (or a `docusaurus` executable on `PATH`).

For Docusaurus, configure the site's `baseUrl` to the block's `/api/canvases/<canvas-id>/blocks/<block-id>/site/` path so its generated assets resolve when opened from the canvas. The `--out-dir` build option is supported by the [Docusaurus CLI](https://www.docusaurus.io/docs/cli).

To enable the included MkDocs example:

```sh
uv venv .venv
uv pip install --python .venv/bin/python -r requirements-site.txt
```

## Connect agents (MCP)

The canvas server is an MCP server at `<your address>/mcp` (Streamable HTTP). Codex, Claude Code, Claude.ai, Cursor, and other MCP clients connect to it directly, so nothing from this repository has to run on their machines. Open **Settings → MCP connections**, create a token for each agent or machine, and copy the ready-made configuration:

- **Claude Code** (`.mcp.json` in your project, with `SYMBIKNOW_MCP_TOKEN` exported in your shell):

  ```json
  { "mcpServers": { "symbiknow": { "type": "http", "url": "https://symbiknow.example.com/mcp",
    "headers": { "Authorization": "Bearer ${SYMBIKNOW_MCP_TOKEN}" } } } }
  ```

  Or: `claude mcp add --transport http symbiknow https://symbiknow.example.com/mcp --header "Authorization: Bearer <token>"`.
- **Codex** (`~/.codex/config.toml`):

  ```toml
  [mcp_servers.symbiknow]
  url = "https://symbiknow.example.com/mcp"
  bearer_token_env_var = "SYMBIKNOW_MCP_TOKEN"
  ```
- **Claude.ai / Claude Desktop custom connector:** add `https://symbiknow.example.com/mcp/t/<token>`. The token is in the path because connectors cannot send headers, so treat the URL as a secret.

Tokens are stored hashed, show their last use, and can be revoked in Settings. History and audit identify the authenticated token; its name is display metadata.

### Tools and shared work

The canonical MCP registry owns every shared tool, schema, permission and handler. Symbi, HTTP and stdio coding agents, and browser WebMCP all use it. Search includes `ask_symbi`, `symbi_reflex`, `search_docs`, `find_by`, and `related`; history, todos, navigation and Jev actions are discoverable from the same catalog. Symbi has full access. External agents use current token grants, including separate approval and configuration permissions.

For working alongside people and other agents:

- `download_file` creates a server-owned checkout and returns its manifest. Edit the downloaded source in the agent's environment, then `upload_file` with explicit `mode`, `checkoutId` and `idempotencyKey`. Replacement preserves the loader and rejects stale revisions; retries return the original saved receipt. `mode=create` explicitly creates a new file; `mode=propose` prepares a reviewable change without saving it.
- Website working copies contain actual source files and binary assets. Branch-targeted downloads and uploads keep private changes separate until merge or approval.
- `claim_doc` holds a document while editing; `release_doc` frees it. History attributes changes to the authenticated caller, independently of its display name.

The browser refreshes the canvas every few seconds, so agent edits and locks appear without reloading.

### Local development only

`npm run mcp` starts the same tools over stdio for an agent on the same machine as a checkout of this repository ([`.mcp.json`](.mcp.json), [`.codex/config.toml`](.codex/config.toml)). It reads `CANVAS_API_URL`. For a protected workspace, export `SYMBIKNOW_ACCESS_TOKEN` before starting the MCP client, or set `CANVAS_API_TOKEN` explicitly; the legacy access-token variable also works. Its `upload_file` / `download_file` can also read and write local paths.

The page also exposes its actions through [WebMCP](https://webmcp.dev/) for an agent that drives the open browser tab through the local `webmcp` bridge (`./node_modules/.bin/webmcp --mcp`, with a token pasted into the widget on the canvas). Like stdio, this only works on the same machine as the browser.

## Checks

Install Chromium once for the browser scenarios (`npx playwright install --with-deps chromium` on Linux):

```sh
npx playwright install chromium
npm run lint
npm run typecheck
npm test
npx cucumber-js
```
