# Symbiknow architecture

Symbiknow keeps original files and their independent versions in an OCFL repository, then builds a replaceable search index over their content. One Python application owns storage writes, one ingestion worker and the embedding runtime. The human interface and MCP clients share that application.

Symbiknow / Development / Runtime architecture

## Components

| Component | Responsibility |
| --- | --- |
| `app/server.py` | MCP upload, download and search; owner lock; transfer receipts; ingestion scheduling and version checks. |
| `app/storage.py` | Native rocfl 1.7.0 operations for original bytes, metadata, versions, integrity and explicit deletion. |
| `app/ingest.py` | Docling conversion, OCR, structural chunking, embedding and publication of current-version representations. |
| `app/embeddings.py` | Pinned model descriptor, guarded index compatibility and one serialized text/vision/idle model owner. |
| `app/torch_quantization.py` | Pinned TorchAO INT8 group-16 text weight compression with float32 arithmetic on tested MPS. |
| `app/conversion_worker.py` | Bounded Docling child lifetime and parent-liveness handling. |
| `app/retry.py` | Durable per-version indexing backoff and permanent-failure pause. |
| `app/previews.py` | Shared bounded/coalesced preview work and disk-cache pruning. |
| `app/cache.py` | Entry/byte-aware LRU for judgment payloads. |
| `app/search_projection.py`, `app/search_metrics.py` | Compact result budgets, pagination projection and request instrumentation. |
| `app/search.py` | LanceDB documents/chunks, keyword/vector/hybrid retrieval, organization filters and stale-hit rejection. |
| `app/jev.py` | TypeSafe Jev decisions over supplied text evidence and bounded choices. |
| `app/organization.py` | Representative evidence, boilerplate filtering, project and subject candidates, and stored-vector candidate ranking. |
| `app/rebuild.py` | Durable selective folder/group/link rebuild requests, progress, skipped outcomes and retry. |
| `app/organization_edits.py` | Schema-one durable manual folder overrides, atomic publication and recovery. |
| `app/evaluation.py` | Per-class answerability and pairwise grouping metrics without exact-name scoring. |
| `app/pdf_thumbnail.py` | Bounded first-page PDF thumbnail subprocess using existing PDFium. |
| `app/relationships.py` | Presentation keys for symmetric relationships while preserving stored evidence. |
| `app/ui.py` | Loopback human API, static frontend, previews, connections and deletion routes. |
| `frontend/src` | React Overview/List/Cards, readable Map/optional Freeform map, focused reader, search, history and confirmations. |
| `client.py` | Official MCP SDK byte-transfer helper with batching, chunks and integrity checks. |

The dependency graph is pinned in `pyproject.toml` and `uv.lock`. The current implementation adds UI and organization modules beyond the six-module layout in the original developer plan.

## Data layout

`data/files` is managed by rocfl using OCFL 1.1 and the hashed n-tuple storage extension. One document ID identifies one OCFL object. Each committed version contains `original` and `metadata.json`; user filenames remain metadata, rather than filesystem paths controlled by uploads.

`data/index` contains the embedded LanceDB `documents` and `chunks` tables. Document rows record the current storage version, indexed version, indexing status, metadata, folder, groups and version-bound links. Chunk rows record evidence IDs, text or visual basis, provenance, embedding model, vectors and organization filters. Reindexing replaces derived chunks without creating a new storage version.

`data/temp` holds incoming chunk files and receipts, organization rebuild state, deletion receipts, cached thumbnails and a manual organization revision. Verified original leases use a bounded `temp/transfers` disk cache; request lookup receipts, per-version retry state, filter-publication markers and the checkpoint-bound rebuild journal also live under `temp`. `index/embedding-runtime.json` and any measured compatibility receipt protect vector compatibility. Model assets use the configured Hugging Face cache. Backups must retain the full data directory, including recovery receipts.

## Upload and indexing

Upload validates a file's base64 bytes and request identity, commits it through rocfl, registers the new head and schedules processing. Storage success is returned before indexing or organization must finish. A single worker converts the committed bytes, embeds bounded batches and publishes the document as indexed only after the corresponding chunks are written.

Text uses Docling's structural/token chunker. PDF extraction retains text/structure without keeping Docling page images; visual embeddings render and release one PDFium page at a time. Production conversion is isolated in a bounded child, and vectors spool through small Arrow batches before publication. Images have native visual embeddings and available OCR. OCR failure may still leave a native image searchable. Empty, unsupported and failed extraction outcomes keep original bytes downloadable.

The worker then asks Jev to organize the document and judge links to nearby documents using representative text. Native image vectors contain no text for Jev to inspect; they do not establish a text answer.

## Version and publication rules

Current search checks the indexed version and the committed OCFL head before returning evidence. Uploading v2 immediately invalidates v1 representations for current search, while explicit downloads can still pin v1. Organization links pin source and target versions and their actual evidence IDs.

Organization publication prepares chunk filters before publishing the document row. Interrupted filter updates can be repaired from document metadata. A superseded source or target is not published as current evidence. In-flight background organization cannot overwrite manual organization or resurrect a deleted document.

## Runtime boundaries

The HTTP server normally binds to `127.0.0.1:8765`. UI mutations enforce local Host, matching Origin and the `X-Symbiknow-UI` header. HTTP MCP sessions share the owner lock and worker; they do not start a second storage process. A stdio server is an alternative owner and must not run against the same data directory concurrently.

Embeddings run locally. Jev organization and evaluated search send selected text evidence to the configured hosted TypeSafe API. Secrets stay in the local environment; `.env` is not project documentation.

## Resource ownership

Text-only embedding work excludes vision; image work replaces the weights under the same model lock. The example selects INT8 text on MPS, with bfloat16 vision; the supported CPU/CUDA fallback is explicitly unquantized. Idle expiry unloads after inference finishes, and heavy OCR conversion first releases cached embedding weights. Runtime descriptors bind model revision, precision, dimensions and preprocessing; configuration changes do not automatically migrate an existing index.

Original transfers use verified version-pinned disk leases. Browser uploads hash incrementally in a worker; ZIP preparation returns a short-lived native download URL. Preview jobs share two workers and eight waiting slots. Jev judgment caches and continuation windows have independent entry/byte budgets. These bound particular allocations; the full extracted structure and library metadata can still grow with content.

## Search presentation and preview ownership — 18 October fixes
`app/search.py` includes the stored-version `created_at` in retrieval; `server._refresh_matches` refreshes it with current metadata and `search_projection.py` preserves it for compact MCP results. The UI and MCP therefore share timestamp provenance. `frontend/src/searchPresentation.ts` sorts loaded search results by filename, type or timestamp without reretrieval; App owns a search-specific column/direction pair separate from server-paged browse sorting.

App captures the invoking preview control, and DocumentInspector delegates close-focus restoration through its callback. The restoration checks that the opener is visible and connected before falling back to an available Open file control or search. `redesign.css` allows the toolbar to wrap and grow above its 64px minimum. Targeted evidence is recorded in `VALIDATION.md`.

## Source references

The executable behavior is defined in `app/`, `client.py` and `frontend/src/`. `README.md` provides setup and transfer examples, `UI.md` describes human-interface behavior, and `VALIDATION.md` records the measured checks and their limits.

## Folder transfer ownership — 19 October 2026
`app/folder_transfer.py` implements the two additive MCP tools registered by `app/server.py`. Uploads delegate original/version commits to existing `upload`, derive a per-path UUID from a folder request UUID, and apply manual placement through `organization_edits`. Durable folder-request bindings and per-file completion receipts live under `temp/folder-uploads`; retain these with the library for retry semantics. No second storage or indexing path is introduced.

Folder downloads capture a bounded metadata selection under the existing locks and stream verified version-pinned originals into temporary ZIPs. Completed archives, hashes and expiry metadata live under `temp/folder-exports`, survive restart until expiry, and are independent of subsequent document updates. Limits bound file count, source bytes, retained snapshots and response ranges. Empty directories are not represented. `client.py` supplies filesystem traversal and byte transfer on the client side.
