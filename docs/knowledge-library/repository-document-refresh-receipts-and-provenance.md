# Symbiknow / Operations / Repository document refresh receipts and provenance

Repository implementation guide. Snapshot: 12 October 2026.

## Selection policy
The project library contains repository guides and its bundled attributed storage standards. Source code can inform a new guide, but secrets, dependency trees, model caches, derived indexes and fictional QA inputs are not automatically useful library documents. Each authored guide names its checked source files and snapshot date.

## Refresh contract
Discover the running MCP schemas and use its upload tool for actual bytes. Inspect known document IDs through MCP download/current metadata. Compare source hashes: unchanged docs stay on their existing version; a changed source updates the existing ID with expected_version and a distinct persisted request ID.

## Verification
Download every new/current pinned version and verify source size/SHA-256. Re-download previous versions to confirm retained history. Wait for indexing and verify the expected current IDs with MCP search. Record stored/indexed/retrieved outcomes separately.

## Receipt content
Keep source path, human library filename, hash/size, request identity, document ID, version, operation and verification flags in an operational JSON receipt. Receipt files themselves are bookkeeping, not additional knowledge content. A resumed script must reuse prepared IDs rather than duplicate an uncertain upload.

## Catalog
Update the repository catalog when adding guides, then refresh that catalog's existing document through MCP. Do not reset the entire library merely to complete a documentation import.

## Source references
- `docs/project-library.md`
- `docs/library-expansion-receipt.json`
- `client.py`
- `docs/mcp-reference.md`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
