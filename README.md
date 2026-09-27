# SymbiKnow

**Make knowledge together.** SymbiKnow is an infinite canvas where people and AI organize ideas and build knowledge together. Spread documents across the canvas, connect related work, and see who contributed and what changed. People work in the browser; AI agents join through the assistant or MCP.



https://github.com/user-attachments/assets/5ee3e2dc-f1d4-4a9a-8868-2f70ed5c20d2


*One minute: teams and their agents share one brain, Jev connects what one team already solved to the team that needs it, and every change stays named and restorable.*

This is the source repository for [SymbiKnow](https://github.com/benrben/symbiknow). It is public for viewing; the original source and brand assets are [all rights reserved](LICENSE). Third-party packages and fonts keep their own licenses.

Each card keeps its source in a separate `.md` file. The canvas stores positions, sizes, groups, and links, while each document has reviewable Git history. Shared tasks help people and agents coordinate. The browser renders Markdown, Mermaid, code, slides, media, MDX, and websites. Both light and dark mode are supported.

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

The repository includes [example environment settings](.env.example). Supply them through your shell or deployment platform; the app does not load `.env` automatically. Keep real keys and `DATA_DIR` out of Git. Run `npm run lint`, `npm run typecheck`, `npm test`, and `npx cucumber-js` before a change; `npm test` builds the app before testing, and [CI](.github/workflows/ci.yml) runs the same checks on pushes and pull requests.

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
| `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY` | Optional environment fallbacks for keys saved in Settings. |

The older `ALLTEAM_ACCESS_TOKEN`, `ALLTEAM_MCP_TOKEN`, and `ALLTEAM_AGENT_NAME` names still work. If both access-token names are set, both tokens and their existing browser sessions remain valid; new browser sessions use `SYMBIKNOW_ACCESS_TOKEN`. Both fixed MCP tokens are accepted. The new agent-name variable takes precedence when both are set. New clients use the `symbiknow_session` cookie and `x-symbiknow-actor` header; the older cookie and header still work for existing sessions and integrations. Stored IDs and workspace data are unchanged. Existing MCP config entries named `allteam-canvas` still connect; `symbiknow` is the new example name. The server warns at startup if `HOST` exposes the canvas without an access token. Request bodies must be JSON, which blocks cross-site form posts.

## Revision history and branches

Each document has its own local Git history under `DATA_DIR/.versions/<block-id>`. Saving that document's source creates a revision whose author is whoever made the change: `Browser`, the chat `SymbiKnow assistant`, `Jev`, or an MCP agent such as `Claude Code - <token name>` or `Codex - <token name>`. Existing revision authors keep their original names. Open **File history** on a canvas card or in its full-page reader to see authors and commits, create or switch branches, merge another branch, and restore an older revision as a new commit. These actions change only that document file; canvas positions, links, and other documents stay in place. A conflicting merge is aborted and leaves the file unchanged. Deleting a document records who deleted it as a final commit, and the last content stays in that history for recovery. Settings and API credentials are never added to the document repositories.

To remove an entire canvas, use the trash button beside its name in the workspace sidebar and confirm. This permanently deletes that canvas's documents, tasks, and file histories, removes links to it from other canvases, and opens another canvas in the workspace. If it was the last canvas, create a new one from the empty state.

## SymbiKnow assistant

Open **Settings** (one page with a section list): **Models**, **Agents**, **Secrets**, **MCP servers**, **MCP connections**, **Plugins & loaders**, and **TypeSafe Jev**.

- **Models:** choose OpenRouter, OpenAI, Anthropic (through its OpenAI-compatible endpoint), or any OpenAI-compatible server such as Ollama or vLLM. Each provider keeps its own key. **Browse models** lists the provider's current models with tool-calling and context badges.
- **Agents:** pick a built-in profile (General, Researcher, Planner, Builder) or add your own profiles with custom instructions.
- **Secrets:** named values such as `GITHUB_TOKEN`. They stay on the server and are never returned to the browser.
- **MCP servers:** connect outside Streamable HTTP or SSE MCP servers so the chat agent can use their tools. Authenticate with a saved secret (`Bearer <secret>`) or `${secret:NAME}` in a header, and use **Test** to list a server's tools.
- **Plugins:** turn tool packs on or off for the chat agent: reading, editing, Jev, shared tasks, and outside MCP tools.

The assistant uses [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview) for tools and [AI Elements](https://docs.langchain.com/oss/python/langchain/frontend/integrations/ai-elements) for the chat interface. Answers stream token by token. Text the model writes before calling a tool moves into the collapsible activity list, so the final answer stays clean. After an answer, Jev checks it against the canvas documents in the background and shows a **Matches canvas docs** or **check the sources** badge under it; the answer itself is never delayed or altered. **Copy** copies the Markdown answer. **New chat** clears the conversation. Drag the left edge of the chat panel to resize it; the width is saved locally. A run can make up to 9,999 tool calls; cancellation and provider errors still stop it.

## Research canvas and view-aware chat

The assistant knows the canvas, group, document, selection, or research block currently in view. The **Using** control below chat lets you choose **Current view**, **Whole canvas**, **Selected documents**, or **Research canvas** when available. Suggested questions change with that focus. Ask it to open a relevant document or group and it can take you there; the chat keeps a return action, and **Research canvas** in the chat header reopens the session's map after you move elsewhere.

For a question that needs several connected findings, Jev can select useful source documents and choose a session research canvas. Short answers stay in chat. If the best surface is unclear, the assistant offers **Build a research canvas**, **Work on this view**, and **Take me to the source**. You can also ask directly to “create a temporary research canvas” or “answer briefly in chat.” Canvas routing and Jev source selection need a TypeSafe Jev key. A chat model is needed to draw and write the answer.

The research canvas keeps growing across follow-up questions in the same chat. The agent can add connected Markdown, diagrams, tasks, slides, HTML, or supported MDX blocks, and cite selected source documents inside the blocks. Sources are links to the original documents, rather than extra evidence cards. Pick **Roadmap**, **Kanban**, **Architecture**, or **Mind map** under **View & export**. You can pan, zoom, search, read, edit, add, move, connect, upload, and undo in the same canvas UI; its focus and suggested follow-ups change as you zoom or select a block. **Save canvas** creates a regular workspace canvas with its blocks and links; **Export Markdown** downloads a readable copy. Unsaved research stays in the current browser session and is cleared by **New chat** or a page reload. See the [research canvas guide](docs/research-canvas.md) for the full workflow.

## Jev canvas insights

Open **Insights** from the top bar or the assistant panel.

**Document groups** is a live dashboard of the canvas grouped by **Work area**, **Purpose**, or **Reading lane**. It uses saved labels right away and Jev's classification after an analysis. Each group shows its size, and every document is one click away (**Show more** expands long groups). **Place these groups on the canvas** runs the grouped layout.

Groups are real frames on the canvas. Drag a group's heading to move the whole group. Links between documents in different groups appear as one dashed edge per pair of groups, labeled with the number of links. Drop a card inside another group's frame to move it there (a work-area or purpose group also relabels the card); drop it well outside its frame to take it out of the group.

Six **Canvas-wide automations** each make one server request that asks Jev only the questions it needs, then saves the result:

- **Organize positions:** classify documents into groups (by the Settings default, or the grouping selected in the dashboard) and place every group on the canvas in rows with space for frames and edges. Documents keep reading order inside their group. Saved labels are reused instead of asked again, and confident new labels are saved on unlabeled cards.
- **Regroup & connect:** Organize, plus Connect.
- **Connect documents:** add up to three top Jev-rated links and remove saved links Jev rejects.
- **Label purposes**, **Classify work areas**, **Assign reviewers:** apply high-confidence labels.

**Analyze canvas** runs every question and adds a reading order, a relevance ranking, and suggestions about links, loaders, labels, duplicates, conflicts, stale information, and missing steps. Suggestions are read-only until you choose **Apply suggestion** or an automation. Add comma-separated **Review teams** in Settings to get reviewer suggestions.

Work-area classification offers 120 built-in labels across software development, product and project planning, sales, marketing, operations, finance, and other domains, plus an `other` choice. **Extra work-area labels** in Settings adds workspace-specific choices. Jev Choice accepts up to 255 options per question ([API reference](https://docs.typesafe.ai/api)), so extra labels stop at that limit. Purpose has 19 choices and reading lanes have 4.

Insights uses [TypeSafe Jev's Choice, Score, and Noul decisions](https://docs.typesafe.ai/primitives) through the [direct TypeSafe Jev API](https://docs.typesafe.ai/introduction/quickstart) with a TypeSafe API key in Settings (or `TYPESAFE_API_KEY`). Jev calls use a pinned model, `jev-1.13.0` by default; set `TYPESAFE_MODEL` to override it. Document analysis goes in batches of 12 and document pairs in batches of 18, all concurrently; duplicate, cross-canvas, and tag suggestions send one Jev request per document or pair instead, with bounded concurrency and a deterministic result order. Jev reads each document's text, with frontmatter removed and, for HTML, styles, scripts, and tags removed. A result is a prompt to review, not a complete audit. A rejected or unavailable Jev call appears as an error and does not change canvas files.

The server validates each request locally before sending it — question ids, option counts, and a combined state-plus-question size under 32,000 estimated tokens — and returns `413` instead of calling Jev when a request is too large. It retries once on a `429` or `529` response (honoring `Retry-After`) before giving up. Noul questions use `true`/`false` criteria keys, never `yes`/`no`. Each policy control in `ChatSettings.jevPolicy` uses one scale, a Noul probability or a Choice/Score confidence, never both; the newer controls are `tag`, `merge_safe`, `stale`, `steps`, `conflict`, `gap`, `reflected`, `layout`, `move`, and `route`.

Settings → TypeSafe Jev shows this month's request count, token count, and estimated cost (at $42 per billion input tokens), and a per-control Show threshold suggested from reviewed suggestion feedback (shown once at least 20 decisions clear a 60% apply rate); **Use** fills the draft Show value without lowering Apply below it. TypeSafe reports its best accuracy in English, so check thresholds separately for non-English documents.

In chat, Jev narrows the tool list for the request (limited to 1.5 seconds, then all enabled tools are offered), confirms that the latest message explicitly asks for a deletion, a substantial edit, or an automation (these fail closed), and checks the answer's support afterwards. Confidence thresholds are initial product settings; check them against your own documents.

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

Tokens are stored hashed, show their last use, and can be revoked in Settings. A token's name is added to the agent's name in file history, so parallel agents stay distinguishable.

### Tools and shared work

Agents get the same canvas people see: `list_canvases`, `read_canvas`, `search_docs`, `read_doc`, `create_doc` (use `kind: "html"` for an HTML page; `website` is only for MkDocs, Hugo, or Docusaurus sites, and HTML content is always kept on the HTML loader), `edit_doc`, `delete_doc`, `move_block`, `link_blocks`, `unlink_blocks`, `upload_file` (complete `content` plus a filename; set `blockId` to replace the whole file), `download_file`, the Jev automations (`regroup_canvas` and `organize_canvas` accept `groupBy`), and per-file history tools (`list_versions`, `create_branch`, `switch_branch`, `merge_branch`, `restore_revision`).

For working alongside people and other agents:

- `read_doc` returns a `contentHash`. Pass it as `expectedContentHash` to `edit_doc` or `upload_file`, and the write fails instead of overwriting a newer change. `message` sets the revision message.
- `claim_doc` locks a document's content for up to an hour (default 10 minutes); `release_doc` frees it. Others get a clear refusal while it is held, and the canvas card shows who is editing. People can take over a lock from the editor.
- `list_tasks`, `create_task`, `update_task`, `claim_task`, and `comment_task` share the canvas task board, which also appears in the assistant's **Tasks** tab and refreshes live.

The browser refreshes the canvas every few seconds, so agent edits, locks, and task changes appear without reloading.

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
