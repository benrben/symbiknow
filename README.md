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
Model assets may download on first use. `SYMBIKNOW_STORAGE_ONLY=1` enables original
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
and connection decisions with Accept, Change, and Skip. Agents use the same queue
through `list_jev_decisions` and `resolve_jev_decision`; handled decisions stay resolved,
and changed files invalidate old proposals. Manual review history remains under Library
actions. Back up `temp/jev-decisions.json` with the rest of the data directory.

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
```

Verification on 2026-10-20: architecture/contracts and frontend unit/build checks
passed. Backend tests had six failures; lint and a browser sample also exposed
existing gaps. See MCP document `9bf808a0-e1b9-5857-8873-ba2b1d72b59b`
for exact results and the test map. Fresh installation and a full browser pass
were not verified.

Keep `.env` and `data/` out of Git. Back up the complete data directory consistently:
`temp/` also contains durable organization and recovery records. Write generated
reports to ignored `artifacts/`. Recovery guidance is in the MCP Start here map.
