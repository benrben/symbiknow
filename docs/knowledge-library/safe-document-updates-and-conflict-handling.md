# Symbiknow / Storage / Safe document updates and conflict handling

Repository implementation guide. Snapshot: 12 October 2026.
## Update the intended object
The same filename does not establish document identity. To update a known document, send its document_id, current expected_version and a new request_id alongside the replacement bytes. Preserve a receipt mapping repository source paths to IDs rather than searching for a similar title and assuming it is the overwrite target.

## Guard before committing
Read the current head through MCP download metadata/history. If the expected version no longer matches, stop and inspect the newer version. Do not bypass the conflict by creating a second object with the same filename. A new request ID is appropriate for a distinct update; an identical retry must retain its original request ID.

## Preserve and verify history
Record the old versions and hashes before updating. After the upload, download the new pinned version and compare it to the source file. Download earlier versions again to confirm their exact hashes are unchanged. Storage commit success can be followed by pending indexing; old chunks must not leak into current search during that interval.

## No-op refresh
When a repository source hash equals the stored current hash, leave the document unchanged. This avoids unnecessary versions and indexing work. Keep the earlier receipt and record the no-op in the new refresh receipt.

## Evidence after updates
Current search only exposes the current indexed head. Historical bytes remain downloadable. Links to an obsolete source/target version are not presented as current relationships, and historical previews do not inherit today's folder, answer judgment or link evidence.

## Source references
- `app/storage.py`
- `app/server.py`
- `client.py`
- `tests/test_storage.py`
- `tests/test_mcp.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
