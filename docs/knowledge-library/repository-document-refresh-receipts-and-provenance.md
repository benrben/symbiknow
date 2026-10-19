# Symbiknow / Operations / Repository document refresh receipts and provenance

Repository implementation guide. Snapshot: 19 October 2026.

## Selection policy
The selected project library contains repository guides and dated PNG/PDF media. The two bundled OCFL standards remain explicitly excluded from the live refresh. Other projects in the library are outside a Symbiknow documentation sync. Source code can inform a new guide, but secrets, dependency trees, model caches, derived indexes and fictional QA inputs are not automatically useful library documents. Each authored guide names its checked source files and snapshot date.

## Refresh contract
Discover the running MCP schemas and use its upload tool for actual bytes. Inspect known document IDs through MCP download/current metadata. Compare source hashes: unchanged docs stay on their existing version; a changed source updates the existing ID with expected_version and a distinct persisted request ID.

## Verification
Download every new/current pinned version and verify source size/SHA-256. Re-download previous versions to confirm retained history. Wait for indexing and verify the expected current IDs with MCP search. Record stored/indexed/retrieved outcomes separately.

## Receipt content
Keep source path, human library filename, hash/size, request identity, document ID, version, operation and verification flags in an operational JSON receipt. Receipt files themselves are bookkeeping, not additional knowledge content. A resumed script must reuse prepared IDs rather than duplicate an uncertain upload.

## Catalog
Update the repository catalog when adding guides, then refresh that catalog's existing document through MCP. Do not reset the entire library merely to complete a documentation import.

## 17 October selection

The current source set includes every Markdown guide under `docs/knowledge-library/`, the root README/UI/validation/memory record, the seven core developer/catalog/planning guides, `docs/memory-runtime.md`, the two tracked memory-reproduction guides and the existing six media originals. Historical plans, validation and media keep their dates. `docs/library-sync-2026-10-17-receipt.json` records this refresh. Runtime settings, private files, operational JSON receipts and synthetic fixtures are excluded from imported content. Discovery may use the read-only library listing; transfers and retrieval verification use the running HTTP MCP owner.

## 19 October UI documentation refresh
The related guides, UI reference, shared-search contract, architecture, status and validation record describe the four fixes checked on 18 October. The sync compares the existing catalog's source hashes with live document heads and uploads changed sources to their existing IDs. `docs/library-sync-2026-10-19-receipt.json` is the operational record; its final status distinguishes verified completion from pending work. Prior histories and unrelated documents are preserved. Historical screenshots keep their original dates, and the separate CDM proposal is not presented as implemented functionality.

## Source references
- `docs/project-library.md`
- `docs/library-expansion-receipt.json`
- `client.py`
- `docs/mcp-reference.md`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
