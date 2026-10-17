# Symbiknow / Architecture / Concurrency and safe publication

Repository implementation guide. Snapshot: 12 October 2026.
## One owner per library
The application takes a process owner lock for its configured data directory. Browser requests and HTTP MCP clients share the same lifecycle and ingestion worker. A separate stdio server must not be started against a data directory already owned by the web server.

## Locks and model work
server.write_lock serializes lifecycle mutations and INDEX_LOCK protects index operations. Native storage has its own write locking. The embedding adapter caches one runtime and serializes inference. A model response is never sufficient permission to publish obsolete content: source and related target versions must remain current.

## Races that matter
An upload can advance the head while older indexing or Jev work is running. Current retrieval rejects the old version independently through both index metadata and OCFL head checks. An in-flight ordinary organization decision cannot overwrite a manual folder correction or a document captured by an active rebuild. Deletion must not be undone by an old indexing result or replayed upload receipt.

Manual organization writes a prepared durable ledger before index publication. Recovery rolls that transaction forward. Filter publication prepares chunk filters before the document row; startup can reconcile interrupted filters from metadata. Rebuild clearing captures IDs durably before changing the selected scope.

## Verification scope
tests/test_http_runtime.py exercises shared HTTP ownership. Backend UI and MCP regressions cover updates during processing, interrupted filter publication and deletion races. These establish exercised contracts, not every possible power-loss timing or production-scale concurrency schedule.

## Source references
- `app/server.py`
- `app/search.py`
- `app/organization_edits.py`
- `app/rebuild.py`
- `tests/test_http_runtime.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
