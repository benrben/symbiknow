# Symbiknow / Operations / Startup reconciliation and recovery runbook

Repository implementation guide. Snapshot: 12 October 2026.
## Startup responsibilities
The owner initializes storage, recovers durable deletion/manual-edit work, reconciles derived metadata with originals and resumes ingestion/rebuild processing. Do not manually modify OCFL inventories or insert fake LanceDB rows to imitate a completed upload.

## Diagnose in order
1. Check that one process owns the intended data directory.
2. Confirm the original current version exists through a pinned MCP download.
3. Compare size/hash with the recorded source or prior receipt.
4. Inspect current indexing and organization states independently.
5. Inspect a durable rebuild's phase/details before deciding whether it needs a failed-item retry.

## Safe recovery patterns
Reindexing replaces derived chunks without creating original versions. Missing-original recovery removes stale derived rows. Interrupted organization-filter publication repairs filters from document metadata. A prepared manual edit rolls forward using its ledger. Clearing-phase rebuild recovery replays uncheckpointed idempotent clears before rebuilding.

Unsupported/empty extraction is terminal, not a reason to schedule an endless reset loop. A provider outage before reset leaves organization intact; failed selected items after a grouping clear stay Unfiled and can be retried. Do not use a new upload request merely to repair an index.

## Native integrity limits
Clean shutdown and recovery receipts reduce known interruption risks. A hard-killed native storage commit or power loss can require OCFL validation or restoration from a verified backup. Current automated recovery cases are not an exhaustive power-cut campaign.

## Source references
- `app/server.py`
- `app/storage.py`
- `app/search.py`
- `app/organization_edits.py`
- `app/rebuild.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
