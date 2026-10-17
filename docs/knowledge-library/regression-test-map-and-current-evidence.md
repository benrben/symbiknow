# Symbiknow / Operations / Regression test map and current evidence

Repository implementation guide. Snapshot: 13 October 2026.
## Latest recorded result
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

## Source references
- `tests/test_storage.py`
- `tests/test_mcp.py`
- `tests/test_http_runtime.py`
- `tests/test_ui_api.py`
- `VALIDATION.md`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
