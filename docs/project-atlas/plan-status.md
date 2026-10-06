# Plan status

> Historical snapshot from an earlier integration pass. For the current implementation, task-ID evidence, corrected Tasks board behavior, and final test results, use [the implementation log](../../work/plan-implementation-log-20261006.md). The results and known issues below describe the earlier snapshot and have not been updated in place.

Where the `docs/plans/symbi-engine.md` work stands ("Symbi: lightweight knowledge, automatic organization, and useful MCP tools", updated 2026-10-06), checked against the code. This page also lists test results and known issues.

> Status meanings: **Done**: code exists and matches the task. **Partial**: some of the task exists, or it is built but not proven. **Open**: not started. The work was still in progress when this was checked, by another session working in the same tree.

## What the plan wants, in short

- Documents stay ordinary files. SQLite holds only derived, rebuildable search data.
- One local index (FTS5 keywords + MiniLM vectors) serves grouping, UI search, and MCP.
- Keep exactly six automatic Reflex actions, made smarter with wider candidates, an 18-role catalog, typed links, and reused answers.
- Give agents two brain tools, `ask_symbi` and `symbi_reflex`, instead of nine Jev tools.
- Make every MCP write version-checked, every read bounded, and branch work isolated.
- Build a canvas-style Tasks board with columns To do → In progress → Blocked → Done.
- Targets: under 2,000 ms execution per document and at most two Jev requests per document where possible, with honest measurement.

## Phase A: baseline and contracts

| Task | Status | Evidence |
| --- | --- | --- |
| A1 Reproduce MCP review findings | Open | Implementation log: "under inspection" |
| A2 Real-data baseline | Open | Only the older `work/jev-logical-grouping-scope-20261006/results.json` |
| A3 Expected retrieval/grouping outcomes | Partial | Small offline fixture `server/symbi-index.fixture.ts` |
| A4 Versioned schemas | Done | `shared/symbi-contract.ts` v1; `CanvasTask.boardOrder` |
| A5 Question audit | Done | `work/symbi-pipeline-implementation-log.md` |

## Phase B: lightweight index

| Task | Status | Evidence |
| --- | --- | --- |
| B1 SQLite + FTS5 index | Done | `server/symbi-index.ts` |
| B2 Offline INT8 MiniLM worker | Partial | Worker and pinned revision exist; **no model installed**, so semantic search falls back to keywords (degraded) |
| B3 Incremental updates, deletion, restart, cache | Done | `upsert`, `remove`, `rebuild`, bounded cache; `server/symbi-index-lifecycle.ts` wired in `server/index.ts` |
| B4 Hybrid retrieval, larger limits | Partial | Ranking blends keyword, semantic, metadata; no graph expansion yet. Link neighbors 12 (max 24), topics 16 |
| B5 Measure MiniLM vs baseline | Open | `server/symbi-index-benchmark.ts` started |

## Phase C: six-action pipeline

| Task | Status | Evidence |
| --- | --- | --- |
| C1 Role catalog, topic candidates | Done | 18 roles, shortlist 10 + none/unknown; 16 topic candidates |
| C2 Reuse, remove unused questions | Done | `addressesAi` and duplicate usefulness removed; exact duplicates decided locally |
| C3 Better labels, typed links, duplicates, placement | Done | Typed directional links; one-canvas placement skips Jev; no-change reasons saved |
| C4 Two dependency-aware provider rounds | Partial | Prefetch batches round 1; request counts not measured |
| C5 Compact durable updates, timeout reasons | Partial | Progress projection added; compact delta storage not migrated |
| C6 / LEG-10 Edit debounce | Done | 150 ms quiet window (max 2 s) for edits; imports start immediately; trailing pass |

## Phase D: MCP and UI

| Task | Status | Evidence |
| --- | --- | --- |
| D1 `ask_symbi` | Partial | `server/api-symbi.ts`, `server/mcp-brain-tools.ts`; semantic/logic/combined, deep links, durable judgment cache with `continuationId`; coverage and request counts not measured |
| D2 `symbi_reflex` | Partial | yes / no / insufficient_evidence with passages and coverage; acceptance in `features/symbi-reflex.feature` |
| D3 MCP-01 … MCP-23 | Partial | See the MCP table below |
| D4 Legacy tools and discovery | Partial | Legacy tools hidden by default; `find_by` and `related` now use shared retrieval (LEG-02, LEG-03); read views accept `limit`/`cursor`; other LEG items not confirmed |
| D5 Retry-safe imports | Done | `POST /canvases/:id/imports` with idempotency keys and per-document results |
| D6 Progress and decision inspection | Partial | Server side done (`runtime-progress.ts`); UI/MCP wiring not confirmed |
| D7 Tasks board | Done | `src/TasksCanvasBoard.tsx` wired from the sidebar |
| D8 Details, create-in-column, drag, order, status control | Partial | Built; dropping at the top of a column can fail (see Known issues) |
| D9 Board verification | Partial | `features/tasks-canvas.feature` exists; full matrix not confirmed |

### MCP-01 … MCP-23

| Task | Tool | Status |
| --- | --- | --- |
| MCP-01 | `list_canvases` counts and timestamps | Done (`/workspaces?stats=1`) |
| MCP-02 | `read_canvas` `includeContent:false` + pages | Done |
| MCP-03 | `read_doc` fidelity | Verify only |
| MCP-04 | `search_docs` `canvasId`, `limit`, pages | Done |
| MCP-05 | `create_doc` reports HTML kind | Done (`kind: "html"` + `storageKind`) |
| MCP-06 | `upload_file` replace needs hash | Done |
| MCP-07 | `edit_doc` needs hash | Done |
| MCP-08 | `download_file` | Verify only |
| MCP-09 | `delete_doc` hash + locks | Done (hash required) |
| MCP-10 | `move_block` compact acknowledgment | Not confirmed |
| MCP-11 | Atomic link updates | Done (`POST /canvases/:id/links`) |
| MCP-12 | `claim_doc` returns hash | Not confirmed |
| MCP-13 | `release_doc` | Verify only |
| MCP-14 | Branch-targeted read/edit | Done (`?branch=`, detached worktree) |
| MCP-15 | `list_versions` UTC + pages | Done (pages) |
| MCP-16 | `create_branch` | Verify only |
| MCP-17 | Safe branch cleanup | Done (`delete_branch`) |
| MCP-18 | `restore_revision` | Verify only |
| MCP-19 | `create_task` | Verify only |
| MCP-20 | `list_tasks` filters + pages | Done |
| MCP-21 | `claim_task` | Verify only |
| MCP-22 | `comment_task` | Verify only |
| MCP-23 | `delete_task` | Done (revision + audit file) |

## Phase E: proof and rollout

| Task | Status |
| --- | --- |
| E1 Compare current, larger limits, reuse, full hybrid | Open |
| E2 Correctness, scope, concurrency, restart, Undo, MCP compatibility | Partial (unit and native tests exist; see results) |
| E3 Cold/warm resources and latency (p50/p95/max per document) | Open |
| E4 Offline fixtures first, bounded real-provider check | Partial (offline fixtures only) |
| E5 Reversible rollout | Open |

## Test results

Two full Vitest runs on 2026-10-06, while the other session was still changing code:

| Run | Passed | Failed | Skipped | Total | Files failing |
| --- | --- | --- | --- | --- | --- |
| ~00:57 | 4,002 | 17 | 12 | 4,031 | 15 of 390 |
| ~01:15 | 3,974 | 57 | 17 | 4,048 | 37 of 395 |

`tsc --noEmit` passed both times. Lint and Cucumber were not run.

Failures in the second run, by area:

| Area | Examples | Likely cause (not yet investigated in depth) |
| --- | --- | --- |
| MCP contract | `mcp-tools`, `mcp`, `mcp-lifecycle`, `mcp-activity`, `collaboration`, `api-jev*`, `jev-chat-tools` | Tests still expect the old contract (no hash on edit, read-modify-write links, legacy tools registered by default) |
| Reflex runtime and actions | `jev/actions.test`, `runtime-question-*`, `runtime-*-resume`, `workspace-read-cache`, `organization-churn`, `lifecycle-history` | Changed questions (removed `addressesAi` and usefulness), new link relations, debounce timing |
| Storage and documents | `storage-validation`, `storage-tasks` (whole file), `document-moves`, `document-deletion`, `version-control.http` | New required hashes, `boardOrder`, and branch rules |
| UI through the real API | `AppAssistantPanel`, `CanvasNodes`, `BrowseGroups`, `Loaders`, `app-chat-actions`, `app-research-save`, `JevThresholds`, `JevAutomaticPanel` | These start a real server; it now also opens the SQLite index on startup |
| Search | `search-candidates.public` | Phrase matching changed |

Treat these as work in progress, not a release state.

## Known issues

1. **Tasks board: dropping above a column's first card fails.** It computes `boardOrder: -1000`, and the server rejects negative values with `400`. See [Tasks board](tasks-board.md).
2. **No embedding model installed.** Semantic search runs in degraded keyword mode until `SYMBI_MODEL_ROOT` points to the pinned MiniLM files.
3. **Old MCP tests still expect the old contract.** They expect read-modify-write links and `edit_doc` without a hash. Update the tests, not the safer code.
4. **Performance targets are unproven.** No p50/p95 per-document timings or request counts exist yet for the new pipeline.
5. **`ask_symbi` logic mode** retrieves by keywords only, and paging can split one document across pages.

## Suggested next steps

1. Fix the negative `boardOrder` drop and add a test for dropping at the top of a column.
2. Update the stale MCP and Reflex tests to the new contracts, or fix the code where a test shows a real regression.
3. Install the pinned MiniLM model offline, run `symbi-index-benchmark.ts`, and record B5 and E3 numbers.
4. Finish LEG-01 … LEG-09 for anyone still using the legacy tools, or set a removal date.
5. Run A1/A2 on the retained real-data fixture before claiming the 2,000 ms and two-request targets.
