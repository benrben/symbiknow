# Symbiknow architecture

Symbiknow keeps original files and their independent versions in an OCFL repository, then builds a replaceable search index over their content. One Python application owns storage writes, one ingestion worker and the embedding runtime. The human interface and MCP clients share that application.

Symbiknow / Development / Runtime architecture

## Components

| Component | Responsibility |
| --- | --- |
| `app/server.py` | MCP upload, download and search; owner lock; transfer receipts; ingestion scheduling and version checks. |
| `app/storage.py` | Native rocfl 1.7.0 operations for original bytes, metadata, versions, integrity and explicit deletion. |
| `app/ingest.py` | Docling conversion, OCR, structural chunking, embedding and publication of current-version representations. |
| `app/embeddings.py` | One cached EmbeddingGemma 2 runtime for text, queries and native images. |
| `app/search.py` | LanceDB documents/chunks, keyword/vector/hybrid retrieval, organization filters and stale-hit rejection. |
| `app/jev.py` | TypeSafe Jev decisions over supplied text evidence and bounded choices. |
| `app/organization.py` | Representative evidence, boilerplate filtering, project and subject candidates, and stored-vector candidate ranking. |
| `app/rebuild.py` | Durable selective folder/group/link rebuild requests, progress, skipped outcomes and retry. |
| `app/organization_edits.py` | Schema-one durable manual folder overrides, atomic publication and recovery. |
| `app/evaluation.py` | Per-class answerability and pairwise grouping metrics without exact-name scoring. |
| `app/pdf_thumbnail.py` | Bounded first-page PDF thumbnail subprocess using existing PDFium. |
| `app/relationships.py` | Presentation keys for symmetric relationships while preserving stored evidence. |
| `app/ui.py` | Loopback human API, static frontend, previews, connections and deletion routes. |
| `frontend/src` | React interface with Files, Canvas, search controls, inspector, history and confirmations. |
| `client.py` | Official MCP SDK byte-transfer helper with batching, chunks and integrity checks. |

The dependency graph is pinned in `pyproject.toml` and `uv.lock`. The current implementation adds UI and organization modules beyond the six-module layout in the original developer plan.

## Data layout

`data/files` is managed by rocfl using OCFL 1.1 and the hashed n-tuple storage extension. One document ID identifies one OCFL object. Each committed version contains `original` and `metadata.json`; user filenames remain metadata, rather than filesystem paths controlled by uploads.

`data/index` contains the embedded LanceDB `documents` and `chunks` tables. Document rows record the current storage version, indexed version, indexing status, metadata, folder, groups and version-bound links. Chunk rows record evidence IDs, text or visual basis, provenance, embedding model, vectors and organization filters. Reindexing replaces derived chunks without creating a new storage version.

`data/temp` holds incoming chunk files and receipts, organization rebuild state, deletion receipts, cached thumbnails and a manual organization revision. Model assets use the configured Hugging Face cache. Backups must retain the full data directory, including recovery receipts.

## Upload and indexing

Upload validates a file's base64 bytes and request identity, commits it through rocfl, registers the new head and schedules processing. Storage success is returned before indexing or organization must finish. A single worker converts the committed bytes, embeds bounded batches and publishes the document as indexed only after the corresponding chunks are written.

Text uses Docling's structural/token chunker. PDF extraction preserves text and page-image representations. Images have native visual embeddings and available OCR. OCR failure may still leave a native image searchable. Empty, unsupported and failed extraction outcomes keep original bytes downloadable.

The worker then asks Jev to organize the document and judge links to nearby documents using representative text. Native image vectors contain no text for Jev to inspect; they do not establish a text answer.

## Version and publication rules

Current search checks the indexed version and the committed OCFL head before returning evidence. Uploading v2 immediately invalidates v1 representations for current search, while explicit downloads can still pin v1. Organization links pin source and target versions and their actual evidence IDs.

Organization publication prepares chunk filters before publishing the document row. Interrupted filter updates can be repaired from document metadata. A superseded source or target is not published as current evidence. In-flight background organization cannot overwrite manual organization or resurrect a deleted document.

## Runtime boundaries

The HTTP server normally binds to `127.0.0.1:8765`. UI mutations enforce local Host, matching Origin and the `X-Symbiknow-UI` header. HTTP MCP sessions share the owner lock and worker; they do not start a second storage process. A stdio server is an alternative owner and must not run against the same data directory concurrently.

Embeddings run locally. Jev organization and evaluated search send selected text evidence to the configured hosted TypeSafe API. Secrets stay in the local environment; `.env` is not project documentation.

## Source references

The executable behavior is defined in `app/`, `client.py` and `frontend/src/`. `README.md` provides setup and transfer examples, `UI.md` describes human-interface behavior, and `VALIDATION.md` records the measured checks and their limits.
