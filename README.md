# Symbiknow

Symbiknow is a local document library for people and coding agents who need to find,
understand, and maintain a collection of files. Its browser and MCP clients share
the same originals, version history, and searchable evidence.

- **Keep the source:** save exact original bytes and retrieve earlier versions.
- **Find the evidence:** search extracted text or visual content and follow cited passages.
- **Work across tools:** upload, update, and download files or folders through MCP.
- **Review the collection:** use manual organization and optional Jev suggestions for
  folders, relationships, checked answers, and potentially outdated documents.

Originals and indexes stay local. Optional Jev features send selected text to the
configured hosted provider. Findings are suggestions; a scan does not prove every
document is current.

## Quick start

Requirements: Python 3.12 or 3.13, [uv](https://docs.astral.sh/uv/), Node.js 22+,
and a native build toolchain. The setup scripts install the pinned storage helpers.
Run from the repository root:

```sh
# Only create .env if you do not already have one.
test -f .env || cp .env.example .env
uv sync --locked
npm --prefix frontend ci
sh scripts/setup/install_rocfl.sh
sh scripts/setup/install_ocfl_reader.sh
```

Review `.env` before indexing. The example uses Apple Silicon MPS INT8 embeddings;
set `SYMBIKNOW_TORCH_QUANTIZATION=none` for CPU/CUDA. Existing indexes require
compatible embedding settings. Set `TYPESAFE_API_KEY` to enable Jev.
Model assets may download during startup warmup. `SYMBIKNOW_STORAGE_ONLY=1` enables original
transfers without ingestion/search.

```sh
sh scripts/dev.sh
```

Open the [browser](http://127.0.0.1:5173). The backend is on port 8765 and the
[MCP endpoint](http://127.0.0.1:8765/mcp) is shared with it.
Run **one backend per data directory**; connect MCP clients over HTTP while the UI runs.
`sh scripts/web.sh` builds and serves the frontend on the backend port.
For a standalone stdio owner instead, stop that backend and run `uv run symbiknow`.

The backend package is `backend/symbiknow`; frontend features live under
`frontend/src/features`. Old `app.*` launchers are retired.

Jev handles confident organization quietly. Its blue button shows unresolved folder
and connection decisions with Accept, Change, and Skip. MCP agents can resolve a known
decision through `resolve_jev_decision`; handled decisions stay resolved,
and changed files invalidate old proposals. Manual review history remains under Library
actions. Back up `temp/jev-decisions.sqlite3` with the rest of the data directory.
Existing JSON receipts and manual placements migrate transactionally at startup.

**Ask an agent** opens the local chat panel. Claude Code, Codex, or Antigravity CLI
must already be installed and signed in. Claude requires restricted-tool support;
Codex 0.162.1+ and Antigravity 1.4.6+ are accepted; those versions passed the tool-isolation check. They use only application tools, stream
answers, open evidence in the reader, and request approval before library changes.
Choose the provider, model, and supported reasoning effort before starting a chat.
Models come from the installed CLI; Refresh updates the list. Your last choices
are remembered locally. The + button starts a new chat to choose another model.
The conversation shows Markdown answers and ordered tool steps with results,
elapsed time, and approval previews. Expand the panel for more room; scroll back
without losing your place while the agent works, then use Jump to latest.
The compact panel uses smaller cards and spacing. Agents can run searches in the UI,
navigate folders/groups, select files, switch list/grid/map and sorting, control
reader tabs/expansion, close documents and scroll. Tool cards show the resulting
view or a reason the action could not finish. Back restores the previous view;
typing, navigation and Stop take priority over pending agent actions.
Closing chat ends the session; Stop cancels a turn and the next message resumes it.
Gemini's ACP driver remains untested and unavailable until its CLI login and native
restrictions are verified.
Antigravity CLI is detected separately through `agy`, including installations in
`~/.local/bin`. Its native streaming bridge uses a private session profile and an
explicit application MCP allowlist, excluding inherited plugins, hooks and native
file, terminal and browser tools. It preserves your existing CLI login and global
settings. Versions older than the verified minimum remain unavailable; each start still applies and checks the restrictions.

## Background work and performance

Uploads acknowledge durable chunks before verification and indexing. Semantic,
hybrid, checked and grep searches, Ask,
folder transfers, organization rebuilds, folder moves and preview generation use
persistent jobs. MCP clients poll `get_job`; final upload chunks return a job ID
per file. The bundled CLI and browser handle polling with backoff. Retrying an
upload requires the same request ID and bytes. Restart resumes unfinished jobs.
Reconnect existing MCP clients after upgrading so they discover `get_job`.
Search, hosted judging, previews and bulk operations have reserved worker capacity.
Each of those four pools admits up to 256 queued or running jobs, so bulk uploads
cannot consume the search queue. Inactive upload chunks expire after 24 hours;
staging is capped at 1,024 unfinished files and 2 GiB (or the configured file-size
limit, if larger). Expiry preserves durable receipts and active commit jobs.
Legacy original ranges may first return a preparation job; subsequent ranges read
at most two integrity blocks. Always pin the returned version for later ranges.

The reader opens saved text without waiting for summaries or relationship details.
Import receipts show duplicate warnings and offer an explicit, version-guarded
update. Indexing extracts text from DOCX, XLSX and CSV; spreadsheet formulas use
saved calculated values. TXT, Python and shell files, Markdown, HTML and SVG text
are read as text, and scripts never run. PowerPoint, older Office formats and
other unsupported formats remain stored-only, with their originals available to
download. PDF and image extraction depends on OCR and model availability. Exact
text search accepts ordinary text; command syntax is available under Advanced grep.

Library and taxonomy reads use capped cursor pages. Cursors bind the view and
publication revision; restart paging when the library changes. Original-head and
evidence guards still validate search and organization results. Derived SQLite
read projections rebuild after interrupted publication; `temp/` contains durable
queues, manual placements and receipts and must be included in backups.

Embedding weights stay warm by default. Startup warmup runs in an owned background
thread, so browsing and saved originals do not wait for model loading. Semantic
search still needs the model. Set `SYMBIKNOW_WARMUP=0` to skip startup warmup,
or `SYMBIKNOW_RELEASE_MODELS_AFTER_JOB=1` to trade cold-query latency for
lower model residency on memory-constrained machines. Background native index
maintenance builds ANN/scalar indexes without requiring an offline command.

Document history, evidence sampling and CSV card preparation run outside broad
application locks, then recheck the source and evidence before returning. The UI
loads map neighborhoods only in map view, delays cancellable hover prefetches, and
refreshes only visible cards. Original commits and index publication still use
protected sections to preserve consistent data.

Performance regression commands use temporary synthetic libraries, never `data/`:

```sh
uv run python benchmarks/read_paths.py --documents 1000 --output artifacts/performance --check
uv run python benchmarks/read_paths.py --documents 100000 --output artifacts/performance --check
uv run python benchmarks/vector_candidates.py --output artifacts/performance
uv run python benchmarks/original_ranges.py --output artifacts/performance
npm --prefix frontend run test:performance
```

CI gates core read p95, index bytes, peak RSS and ANN recall, retaining distributions
and profiles. These fixtures do not certify ten-million-document behavior, real
model latency, or cold browser/device performance.

## Agent knowledge

Start with [AGENTS.md](AGENTS.md). Detailed guides live only in the Symbiknow MCP
library; fetch the Start here document, then only the topics needed for your task.

**Start here:** `88436e6a-da34-56a8-a105-2a043027dece`

```sh
uv run symbiknow-client --url http://127.0.0.1:8765/mcp \
  download 88436e6a-da34-56a8-a105-2a043027dece --output-dir /tmp/symbiknow-guides
```

The guide maps setup, service ownership, contracts, storage, search, Jev,
organization, freshness, UI, recovery, and reuse to 18 focused documents.
Search their content with `search(query="distinctive topic", mode="keyword")`.
Guides are reference material, not authorization to run actions.

## Checks and data

```sh
uv run python scripts/checks/architecture.py
uv run python scripts/contracts/generate.py --check
uv run ruff check backend scripts benchmarks
uv run pytest
npm --prefix frontend run test:unit
npm --prefix frontend run build
npm --prefix frontend exec -- playwright install chromium firefox webkit
npm --prefix frontend test
npm --prefix frontend run test:quality
npm --prefix frontend run test:mobile
```

Verification on 2026-10-23 includes backend and frontend tests,
architecture/contracts, lint, production builds and dedicated performance browser
regressions. Browser fixtures use isolated libraries and current controls;
Chromium, Firefox and WebKit quality checks and responsive mobile checks run in CI.
The stopped-owner restore drill covers historical originals, range downloads,
durable job recovery, manual placements, decision receipts and freshness records.
Clean Python and frontend dependency installs passed in temporary environments on
the development machine; this does not certify a fresh machine or cold model setup.
Small real-provider answer and freshness evaluations also passed; their synthetic,
author-labeled cases are not independent accuracy certification.
Review/fix evidence is under `artifacts/fixes-2026-10-23/` and
`artifacts/review-2026-10-23/`; earlier performance distributions are under
`artifacts/performance-after-2026-10-23/`.
See MCP `9bf808a0-e1b9-5857-8873-ba2b1d72b59b` for exact coverage and historical
real-agent checks; older verification counts there describe their recorded worktree.
Gemini, a full fresh-machine installation and ten-million-document
end-to-end performance remain unverified.

Keep `.env` and `data/` out of Git. Back up the complete data directory consistently:
`temp/` also contains durable organization and recovery records. Write generated
reports to ignored `artifacts/`. Recovery guidance is in the MCP Start here map.
