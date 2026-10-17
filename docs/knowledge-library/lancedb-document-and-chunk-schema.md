# Symbiknow / Architecture / LanceDB document and chunk schema

Repository implementation guide. Snapshot: 12 October 2026.

## Two related tables
The documents table records document_id, current version, indexed_version, status, filename/MIME/source, SHA-256, size, index_error, searchable_text/visual, chunk_count, folder/groups, links_json, organization_status/organization_json and created_at. A metadata row can exist before searchable content does.

The chunks table records chunk_id, document_id, version, text, basis, provenance_json, a fixed-size float32 vector, embedding_model, active and replicated folder/groups filters. Content and provenance support retrieval; organization copies permit prefiltering.

## Replacement and compatibility
put_chunks removes previous derived chunks for one document ID and appends the current representations. It validates the configured vector width against the existing table. A mismatch requires rebuilding the derived index; silently mixing widths is rejected. FTS is created when absent and the implementation relies on Lance's indexing of appended fragments.

## Reading a row correctly
version is not equivalent to indexed_version. A current head can be pending while its former representations are being replaced. Only an indexed row whose version matches both its chunks and OCFL head can support current search. Original bytes are stored separately in OCFL, not reconstructed from vectors or excerpts.

## Source references
- `app/search.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
