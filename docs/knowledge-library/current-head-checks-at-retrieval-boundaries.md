# Symbiknow / Architecture / Current head checks at retrieval boundaries

Repository implementation guide. Snapshot: 12 October 2026.

## The stale-hit problem
Suppose v1 is indexed and v2 has committed while reindexing is pending. A vector/full-text engine may still contain v1 rows. Current search must not label those as evidence for v2 merely because the document ID matches.

## Layered gates
find_documents starts with active chunks and optional organization/model filters. For each hit it verifies the documents row is indexed, that indexed_version and version match the chunk version, and that the independently read OCFL current head agrees. Missing/deleted heads are rejected.

The public MCP search then checks heads again before returning matches. It performs another check after optional hosted Jev evaluation, since a content update can occur while the provider is answering. Stored links are also checked against target versions.

## Expected behavior
An updated document can temporarily have no current search hit; its original v2 remains downloadable. Explicit historical download of v1 is still valid. Tests exercise an unindexed new head and update races rather than assuming index metadata alone is sufficient.

## Troubleshooting
Check stored current_version, indexing_status and the returned match version. Do not recreate a document or merge older evidence into a new answer to avoid the pending interval. Reindex the committed head using the normal owner.

## Source references
- `app/search.py`
- `app/server.py`
- `tests/test_search.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
