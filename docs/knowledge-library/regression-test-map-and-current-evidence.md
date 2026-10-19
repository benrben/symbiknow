# Symbiknow / Operations / Regression test map and current evidence

Repository implementation guide. Snapshot: 19 October 2026.
## Recorded review10 result
The review10 follow-up on 13 October recorded 194 backend tests passing in 182.78 seconds and 66 UI tests passing in1.8 minutes, with two existing optional fixture tests skipped. Ruff and the production build passed. Live MCP accepted the correcting t0 passage for both reviewed paraphrases;24 browser navigation states and visible subject/negation ranges passed. Earlier deep-review results were93 Python/31 browser scenarios and remain historical evidence. These are the recorded run results, not a promise that every future checkout or host has passed.

## Test map
Storage tests cover bytes, history and conflicts. MCP tests use actual SDK transports for bulk/chunked upload/download, replay and reconciliation. HTTP runtime tests cover a shared owner and worker. Search/ingest tests exercise current-head rejection, representations and evidence. Jev tests use mocked official SDK HTTP responses to validate allowed choices and real passage IDs.

UI API tests cover folder/subtree edits, filters, reset semantics, progress/retry/recovery, concurrency, deletion and bulk ZIP. Browser tests use an isolated OCFL/LanceDB library with deterministic embedding/Jev, and some controlled response fixtures. New review regressions cover Space ownership, filtered counts, sorting, GFM, history/reset copy, tree focus and compact multi-project overviews.

## Hosted evaluation scope
The final policy10 matrix includes122 document judgments across pinned/self-authored and reused regression corpora. All supplied windows, local references and frozen source hashes were checked. Uncertain labels, possible references and a historical inconsistent-document support miss remain in raw receipts. This matrix is not independent annotation or a general accuracy estimate. Exact methods and counts are in `outputs/review10-followup/jev/report.md`.

## Evidence locations
VALIDATION.md records chronology and limits. `outputs/review10-followup/verification.json` links the final policy10 test, source/build, browser and integrity receipts. outputs/deep-review-fixes contains final results, source/build hashes, screenshots, originals verification and reset serialization profile. outputs/desktop-redesign contains the earlier desktop implementation evidence. Imported historical plans must not override current implementation records.

## Remaining work
Actual screen-reader sessions, target native runtime, complete backup/restore drills, full corpus capacity and independently labeled hosted quality remain separate acceptance checks. Repeated reruns are not additional unique tests.

## 17 October verification sources

The memory follow-up records 273 backend tests passing in 312.98 seconds, 21 related browser flows, Ruff and a production build; see `Optimize-memory-symbiknow.md` and `outputs/memory-research/followup/full-tests-result.json`. These are dated recorded results, not a new full-suite run during documentation sync. Current test modules additionally cover quantization guards, memory/retry/preview boundaries and answer-part routing.

`UI.md` documents the newer focused-reader and readable-map checks. Node unit tests live under `frontend/tests/unit/`; Playwright quality/mobile configurations use synthetic API routes on port 5176, separately from the legacy disposable OCFL fixture suite. Cross-browser/axe and device emulation remain distinct from model quality, physical-device or screen-reader validation.

## Manual UI report verification — 18 October 2026

Four reported issues were repaired: search header direction, missing saved-version dates in results, preview focus restoration and toolbar clipping at intermediate widths. Verification passed 95 backend tests (`test_search.py`, `test_ui_api.py`, `test_search_entrypoints.py`, `test_mcp_five_fixes.py`), five search-presentation Node tests, five `manual-ui-regressions.spec.ts` browser tests, and the TypeScript/Vite production build. These 105 focused tests are not a new full-suite result or an accuracy measurement.

The browser fixture supplies 70 documents and covers both sort directions, current/historical preview close routes, Quick Look, removed-opener fallback, and toolbar widths 390–1024px at normal and 1.25 CSS zoom. CSS zoom is not exhaustive browser zoom certification. Live keyword verification checked seven results against browse timestamps. All 98 live documents' original inventories remained unchanged during verification; no provider calls were made for these checks. Evidence: `outputs/ui-bug-fixes-2026-10-18/verification.json` and `toolbar-800.png`. Documentation sync on 19 October is a separate operation and legitimately creates new document versions.

## Source references
- `tests/test_storage.py`
- `tests/test_mcp.py`
- `tests/test_http_runtime.py`
- `tests/test_ui_api.py`
- `VALIDATION.md`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.

## Folder MCP tools — 19 October 2026

Added `upload_folder` and `download_folder`, bringing the advertised API to five tools. The focused run passed **92 tests in 156.49 seconds**, including 15 folder-transfer cases and existing MCP/search regressions. Ruff passed. Real MCP HTTP and stdio checks cover nested relative paths, exact binary bytes, chunk resume across restart, stable retry identities, guarded updates, partial placement recovery, later manual moves, ZIP snapshots across updates/restart, collision handling, invalid paths, export limits/expiry and failed-export cleanup. Client ZIP saving verifies the complete hash and refuses overwrite.

Tests used isolated temporary libraries; they do not establish full-library scale, hosted-model quality or a production load benchmark. Commands and output: `outputs/folder-tools-2026-10-19/tests.log`; source hashes and test scope: `outputs/folder-tools-2026-10-19/verification.json`. Live activation and original-inventory preservation are recorded separately in `activation.json`.
