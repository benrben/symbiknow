# Symbiknow / Architecture / Ingestion lifecycle and processing states

Repository implementation guide. Snapshot: 12 October 2026.
## Independent outcomes
An upload's stored result confirms committed bytes. Searchability requires an indexed current version. Organization is a further step with its own status. These outcomes should never be collapsed into one success badge.

| Index state | Meaning for the user |
| --- | --- |
| pending | Original stored; current content awaits indexing. |
| indexed | Current textual or visual representations were published. |
| empty | No textual or visual evidence was extracted. |
| unsupported | The original is stored but this indexing format is unsupported. |
| failed | Processing failed; the original remains downloadable. |
| disabled | Storage-only operation does not run indexing. |

## Publication sequence
The worker reads a committed version and verifies its hash before conversion. Text embeddings are computed in small batches; visual embeddings are processed individually. Before publishing it checks the storage head again. If a newer version has arrived, older work is superseded rather than reported as current evidence.

The documents row records version, indexed_version, chunk_count, searchable text/visual flags and processing details. Chunk rows remain derived and replaceable. Unsupported/empty files are terminal outcomes, rather than endlessly eligible organization retries.

## Troubleshooting distinction
A stored-but-pending document can legitimately be absent from search. A visually indexed image without text cannot receive a text answer badge. A provider organization failure should be investigated separately from extraction or storage failure. Use the current document's status, and keep a pinned download available even when the derived representation is unavailable.

## Source references
- `app/server.py`
- `app/ingest.py`
- `app/search.py`
- `frontend/src/api.ts`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
