# Symbiknow / Search / Keyword search diagnostics for imported guides

Repository implementation guide. Snapshot: 12 October 2026.

## First determine whether indexing finished
Storage success alone does not make a guide searchable. Use MCP download's indexing_status/searchable for the current version. A pending head may correctly produce no search hit even when an older version used to match.

## Use a narrow textual probe
For source-backed Markdown guides, search an exact substantive heading phrase in keyword mode. Quote a phrase when a contiguous title is the intended probe. Use limit high enough to distinguish the expected document from a catalog that also mentions its title. Check document_id and version, not just a displayed filename.

The previous expansion verified all twenty-nine new guides through MCP keyword searches and then ran representative keyword/hybrid queries. Its receipt identifies that specific corpus/run; it does not certify broad relevance accuracy.

## Broaden intentionally
Clear folder/group filters if the expected document belongs elsewhere. Check current metadata counts separately from retrieved-candidate counts. Hybrid/semantic retrieval can help differently worded questions but should not obscure a basic indexing failure.

## Record evidence
A useful import receipt stores query, mode, expected ID, expected current version and whether that exact version was returned. A nonempty result list is insufficient if it contains only an older guide or a similarly titled document.

## Source references
- `app/search.py`
- `docs/mcp-reference.md`
- `docs/library-expansion-receipt.json`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
