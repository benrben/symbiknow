# Optimize memory in Symbiknow

Updated: 17 October 2026.

**Independent implementation review:** A second review found and fixed three
gaps in tasks 4, 13 and 16: conversion filename collisions, a separate database
commit for each four-chunk batch, and preview eviction racing a cache read.
Fresh isolated tests and speed/RAM measurements are recorded in the
[implementation review](outputs/memory-research/implementation-review/README.md).
The earlier validation and live-server observations below retain their original
scope; this review did not restart or migrate the live library.

This document records implementation and verification on the Apple M5 Pro. **All 20 tasks are complete under the user's revised requirement: 8-bit PyTorch, without MLX.** The live server was restarted on port 8765 (PID **54272**). All **89 indexed documents** remain present and the aggregate hash of **272 OCFL inventory files** is unchanged. Stored vectors and the original float32 index manifest were preserved; a measured compatibility receipt authorizes INT8 queries. `.env` and `.env.example` select torch/INT8; automatic runtime selection also stays torch. Historical MLX research remains unused.

**Final validation:** **273 backend tests and 21 related browser flows pass**, plus production build and Ruff. Existing-index validation covered 80 generated bilingual queries: **100% first-result agreement**, **98.75% top-three overlap**, minimum query cosine **0.999737**, and no expected-match losses. Separate rebuilt production-chunk, real-photo, scanned-PDF, original-byte and overlapping ingestion/search checks pass. Generated labels do not certify broad production accuracy; the float32 baseline itself missed the earlier absolute 90% top-three target.

**Approximately 1 GiB describes settled idle memory, not the OCR peak.** Final live idle physical footprint is **720 MiB**, with zero active MPS tensors after the actual 60-second timeout. The matched isolated INT8 server settles at **911 MiB**; three model-only use/idle cycles settle at **1,060 / 1,065 / 1,067 MiB** after text reloads. These are different scopes. Earlier approximately 3.3 GiB readings were taken immediately after unloading; physical accounting takes time to settle. Releasing cached embeddings before heavy conversion plus INT8 reduces the matched server/child peak from **6.06 to 3.98 GiB**. The final dense two-page scanned-PDF workload still peaks at **5.00 GiB**. GPU counters overlap physical footprint and are never added to it.

The goal is to use much less RAM while keeping good English/Hebrew search, image search, file history, and reliable uploads. Optimize the biggest costs first. Do not replace working components just to make the architecture look smaller.

**Historical initial experiments — not the active runtime**

The same pinned EmbeddingGemma 2 checkpoint was tested with audio disabled. In the quantized models, the text encoder uses 8 or 4 bits; the vision encoder stays in bfloat16.

| Runtime and configuration | Process memory with the model loaded, after clearing unused cache |
| --- | ---: |
| PyTorch float32, text + vision | 3,178 MiB |
| PyTorch bfloat16, text + vision | 2,002 MiB |
| MLX bfloat16, text + vision | 1,248 MiB |
| MLX 8-bit, text + vision | 1,073 MiB |
| MLX 4-bit, text + vision | 943 MiB |
| MLX bfloat16, text only | 972 MiB |
| MLX 8-bit, text only | 733 MiB |
| MLX 4-bit, text only | 607 MiB |

These are **embedding-process measurements, not total app RAM**. They exclude Docling, the live server, the database, and browser memory. Savings compared with PyTorch include changing the runtime as well as the precision. MiB means 1,048,576 bytes.

The small test contained 24 passages, 48 English/Hebrew queries, and 12 generated images. Float32 found the expected passage first for 40/48 queries; 8-bit scored 41/48 and 4-bit scored 40/48. All three found the expected image first for 12/12 image queries. This does not prove that 8-bit is more accurate than float32.

Eight-bit stayed much closer to the original text vectors: the lowest cosine similarity was 0.9983, compared with 0.9245 for 4-bit. Higher means closer; it is not an accuracy percentage. The largest 4-bit changes occurred on Hebrew queries. The earlier preference for 8-bit is superseded by the user's explicit choice of regular PyTorch.

Unused allocator cache also matters. After image work, the default 8-bit MLX process retained about 2.63 GiB. A 128 MiB cache limit reduced retained memory to about 1.17 GiB, with an observed peak around 2.01 GiB. But the tight cache sometimes slowed queries substantially. It is a test setting, not an approved production default or a total-memory limit.

Evidence: [quantization results](outputs/memory-research/quantization/summary.json), [benchmark script](outputs/memory-research/quant_bench.py), and [earlier embedding/Docling probes](outputs/memory-research/summary.json). The checkpoint revision is `2c791de4ddbe5cabd592cc93692f7acb67e52555`. The isolated MLX tests used MLX 0.32.3 and MLX-VLM revision `3d87e88402f307efbf68e568971aa887ee7d9ed0`.

Task descriptions below retain the original observations and tradeoffs. Checked
items and the completion table record the implemented final behavior.

**The six agreed tasks**

- [x] **1. Use 8-bit PyTorch embeddings for normal searches (revised without MLX).**

  Current requirement: regular PyTorch with 8-bit text weights, without MLX. The
  integrated runtime uses pinned TorchAO 0.17.0, symmetric groups of 16, float32
  text arithmetic and bfloat16 vision. Vocabulary conversion is bounded to 2,048
  rows, and lookups decode only requested token rows. The supported unquantized
  CPU/CUDA runtime remains available. MPS is the tested 8-bit execution platform.

  Keep the current query/document prefixes, tokenizer, normalized 768-dimensional
  vectors, and image behavior. Pin runtime and conversion settings so updates
  cannot silently change results. The earlier MLX adapter and measurements below
  remain historical and unused.

  Code: [app/embeddings.py](app/embeddings.py), [app/torch_quantization.py](app/torch_quantization.py), and [tests/test_torch_quantization.py](tests/test_torch_quantization.py).

  Before switching an existing index, record the model revision, runtime, quantization, dimensions, and preprocessing settings. The current `embedding_model` field alone is not a complete compatibility record. Verify searches against existing float32 vectors; rebuild the derived index if compatibility is not good enough. Keep original files untouched.

  Done when: real English/Hebrew, image, and PDF retrieval tests pass; failures are clear; the app runs without loading a second fallback model unnecessarily; full-app RAM is measured. The small synthetic result alone is not the release gate.

- [x] **2. Load image processing only when needed.**

  Use the text-only encoder for text queries and text indexing. Load vision for image and PDF-page embeddings. Text queries must still find stored image vectors. Audio is already disabled and should stay disabled.

  Code: [app/embeddings.py](app/embeddings.py), [app/search.py](app/search.py) `find_documents`, and [app/ingest.py](app/ingest.py) `index_document`.

  Share one model lifecycle manager with tasks 1 and 3. Avoid keeping two complete copies of the text encoder when changing modes. Decide explicitly whether a vision job temporarily replaces the text-only runtime or uses an isolated worker with a bounded lifetime.

  Done when: text searches do not load vision, image ingestion still works, and overlapping searches/uploads do not create duplicate model copies. The local probes produced identical text vectors with vision enabled and disabled.

- [x] **3. Unload models when the app is idle.**

  Reopened verification now passes with regular PyTorch INT8: three real text/image/use/idle cycles, real full-server 60-second expiry, zero active MPS tensors after unloading and successful shutdown. Settled model-process samples after text reloads are 1,060 / 1,065 / 1,067 MiB. Full-server idle is 911 MiB in the matched workload. These are separate scopes, not a combined memory ceiling.

  Replace permanent model caching with controlled lifetime management. Start by testing an adjustable idle timeout near 60 seconds. Count active users of the model and unload only after all requests finish. Synchronize the device, release references, and clear unused allocator cache. Prevent a new request from racing an unload or loading a duplicate model.

  Code: [app/embeddings.py](app/embeddings.py) and [app/server.py](app/server.py) application lifespan and worker coordination.

  Tradeoff: the first search after unloading takes longer. Keep the model warm during a batch of uploads or an active search session. A previous embedding-only bfloat16 probe settled around 560 MiB after unloading; that is not a complete-server target.

  Done when: repeated use/idle cycles return to a stable low footprint, requests finish correctly, shutdown is clean, and cold-search delay is measured.

- [x] **4. Release PDF/OCR processing resources after conversion.**

  Move Docling conversion into a short-lived child process. It should return extracted structure or temporary artifact paths, then exit after a job or a bounded batch. Keep storage ownership and final index publication in the main server. Pass paths or bounded messages instead of copying large documents and image lists between processes.

  Code: [app/ingest.py](app/ingest.py) `_converter` and `extract_units`; [app/server.py](app/server.py) `reconcile_once`.

  The cached converter retains initialized pipelines. After the synthetic PDF probe, clearing model/converter references still left about 3.22 GiB after five seconds. That shows retained memory, not proof of a leak. Also avoid loading embedding weights before conversion when only the tokenizer is needed. Where practical, finish conversion before starting embedding inference so the two heavy stages overlap less.

  Done when: memory drops after the conversion child exits; cancellation/crashes leave originals safe and indexing retryable; heading, table, page, and OCR evidence remains correct; temporary artifacts are cleaned up.

- [x] **5. Process pages and image frames in bounded amounts.**

  The current code builds a list containing every decoded image frame and collects all generated PDF page images before embedding them. A batch size of one does not help if all remaining images are still held in that list.

  Code: [app/ingest.py](app/ingest.py) `extract_units` and `index_document`; [app/pdf_thumbnail.py](app/pdf_thumbnail.py) provides an existing PDF rendering pattern.

  Keep the complete extracted document structure for correct chunking, but test disabling retained PDF page images and rendering individual pages for visual embeddings afterward. Preserve the current useful rendering quality; thumbnail-sized images are not automatically suitable for embedding. Decode and release multi-frame images one frame at a time. Test smaller Docling stage batches and queues; the installed pipeline defaults include batch sizes of 4 and a queue size of 100.

  Done when: a long PDF or multi-frame image does not keep all decoded pixels in RAM; page numbering, cross-page structure, and visual search remain correct. Measure 10-, 100-, and larger-page examples instead of promising constant total memory.

  Docling documents queue/buffer controls in its [resource guidance](https://docling-project.github.io/docling/usage/advanced_options/#limit-resource-usage). Check each setting against the pinned installed version before using it.

- [x] **6. Clear unused temporary memory after heavy work.**

  Reopened verification now passes with actual PyTorch observations. Unloading is followed by short OS accounting/allocator settling; immediate samples overstated settled retention. INT8 conversion bounds temporary float32 rows, lookups decode only requested tokens, and cached weights are released before image/PDF conversion under the inference lock. Full-server runs and three use/idle cycles show zero active MPS tensors and stable settled memory. No malloc-pressure-relief call or cache flush after every small query was added.

  Separate active model memory from unused allocator cache. Release conversion results, image buffers, completed batches, and unused GPU cache at safe job boundaries. Test cache budgets instead of forcing the smallest value everywhere.

  Code: [app/embeddings.py](app/embeddings.py), [app/ingest.py](app/ingest.py), and the runtime manager introduced above.

  This differs from task 3: the model may remain loaded while unused working memory is released. Avoid clearing cache after every layer or every small query. In the benchmark, a 128 MiB cache limit changed memory substantially but sometimes made queries much slower. MLX's [cache limit](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.set_cache_limit.html) controls unused cached allocations, not all memory used by the process.

  Done when: memory settles after image/PDF work, repeated workloads do not keep raising the idle footprint, and measured query/import speed remains acceptable.

**More opportunities found in the code**

These original proposals came from source review. They are now implemented; measured
results and unquantified savings are distinguished in the completion table. The
original suggested priorities remain below for context.

- [x] **7. Stream large files on the server instead of reading them completely. High priority.**

  [app/storage.py](app/storage.py) `_run` captures the entire rocfl output, and `read_file` returns the complete original as bytes. [app/server.py](app/server.py) `download` then slices a small range from that complete file. A full 256 MiB download through 256 KiB ranges can therefore cause 1,024 full-file reads and hashes: roughly 256 GiB of logical input processing, even if the OS disk cache helps. Chunked upload finalization also uses `part.read_bytes()`.

  Add a shared, version-pinned transfer path that streams rocfl output into a verified temporary file, then serves ranges without rereading the complete original for every request. Use bounded disk caching with cleanup, or another rocfl-supported streaming path. Stream into ZIP entries and HTTP responses. Preserve whole-file SHA-256 checks, upload retries, expected-version checks, deletion handling, and the storage lock contract; do not bypass rocfl by guessing repository paths.

  Done when: large uploads/downloads/ZIP exports have bounded RAM, range downloads do not repeat whole-file work, and interrupted transfers preserve the existing integrity guarantees.

- [x] **8. Reduce browser memory during uploads and ZIP downloads. High priority.**

  [frontend/src/api.ts](frontend/src/api.ts) `uploadFile` loads the entire file with `arrayBuffer()`, hashes it, and then makes chunk copies and base64 strings. [frontend/src/App.tsx](frontend/src/App.tsx) `bulkDownload` waits for a complete ZIP Blob before starting the browser download; the server allows exports up to 1 GiB.

  Read upload chunks with `file.slice()`. For the whole-file hash, use a proven incremental hashing implementation in a worker, or redesign the protocol carefully; moving the current whole-file buffer into a worker alone does not reduce total memory. Browser `SubtleCrypto.digest()` [does not accept streaming input](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest). For ZIPs, consider preparing the export and handing the browser a short-lived download URL, with bounded lifetime and cleanup.

  Done when: large transfers no longer require an application-held full-file buffer, upload idempotence remains intact, and browser memory is measured separately from server memory. Do not claim native browser buffering is zero.

- [x] **9. Stop rereading the whole library on unchanged UI polls. High priority.**

  [frontend/src/App.tsx](frontend/src/App.tsx) polls every four seconds and refreshes every loaded page. Each [app/ui.py](app/ui.py) `_library` call also scans document metadata to rebuild folder/group/status counts. The frontend additionally compares whole objects through repeated `JSON.stringify` and searches the old document list for every new row.

  Add a small revision/progress response and fetch library pages only when relevant data changes. Reuse aggregate counts by revision and scope; invalidate them on uploads, deletion, indexing/status changes, and manual/automatic organization edits. Use an ID map for row comparison. Pause or slow polling in hidden tabs, and prevent overlapping polls. Batch pending-upload status lookups rather than requesting full document details for each item.

  Done when: an unchanged library does little work while idle, progress still updates promptly, and folder counts, visible versions, and deletion results remain fresh. This mainly targets CPU, repeated allocation, and responsiveness.

- [x] **10. Read only the database columns needed by each operation. Medium priority.**

  [app/search.py](app/search.py) `document_evidence` retrieves full chunk rows and then drops their vectors. `find_documents` also materializes full result rows, although the response does not need the stored vector arrays. `browse_documents` reads internal JSON fields that [app/ui.py](app/ui.py) `public` subsequently removes. `document_evidence` can perform one offset query per sampled passage, up to the caller's limit.

  Use explicit result-column selection and batch evidence reads where practical. Vector search still needs vectors internally; the aim is to avoid copying unused vectors into Python. Preserve scoring columns, sampling coverage, stable ordering, and freshness checks. LanceDB supports selected-column queries and [query-plan inspection](https://docs.lancedb.com/search/optimize-queries).

  Also profile `_db`/`_table`, which reconnect/open tables on each helper call. Only introduce a small connection/table owner if the pinned library's thread-safety and freshness behavior support it and a benchmark shows a benefit. Repeated calls alone do not prove a connection leak; reuse can retain more cache.

  Done when: results are unchanged, fewer columns/queries are materialized, and measurements show lower allocation or latency.

- [x] **11. Simplify organization-rebuild bookkeeping. Medium priority; more important for large libraries.**

  [app/rebuild.py](app/rebuild.py) `status` reads and parses the complete job JSON. `process_one` builds completed/remaining collections and rewrites the state repeatedly as the job advances. Folder preparation also collects evidence profiles for all selected documents. The worker checks job state even while idle. The UI already returns a reduced public response; the remaining cost is internal state handling.

  Keep one in-memory job snapshot with explicit invalidation, a compact progress view, and an efficient next-item cursor. Start with smaller internal changes before adding a new job database. Bound profile preparation or spill large intermediate data to disk where possible. If checkpoint frequency changes, keep completed work safely replayable and preserve recovery behavior.

  Done when: restart/retry/deletion tests pass and increasing the document count does not repeatedly rebuild and serialize the whole job for every item. The full rebuild pipeline needs measurement; existing synthetic organization tests exclude parts of it.

- [x] **12. Avoid copying the full manual-organization ledger for simple reads. Medium priority.**

  [app/organization_edits.py](app/organization_edits.py) `read` deep-copies the whole state, and `_loaded` can retain four file/revision snapshots. [app/ui.py](app/ui.py) `_library` calls `read` more than once during the same request.

  Read one consistent snapshot per request. Add narrow accessors for assignments, revision, and progress; copy data only when a caller is going to edit it. Keep a bounded latest snapshot per active data directory and release obsolete revisions. Do not expose a shared mutable dictionary to arbitrary callers.

  Done when: large assignment maps create fewer full copies, concurrent readers cannot mutate shared state, and atomic writes/recovery remain correct.

- [x] **13. Keep embedding batches in compact arrays until storage. Medium priority for large documents.**

  [app/embeddings.py](app/embeddings.py) `_encode` converts NumPy vectors to nested Python lists. [app/ingest.py](app/ingest.py) accumulates all chunk rows before [app/search.py](app/search.py) `put_chunks` builds another list for LanceDB. Python float objects use substantially more memory than packed float32 arrays.

  Pass NumPy/Arrow batches through the indexing path and avoid unnecessary row copies. For very large documents, stage batches on disk or in unpublished derived rows. Publish the complete version only after every batch is valid. Keep the current checks that prevent stale or partial document versions from becoming searchable.

  Done when: large-document indexing uses less intermediate memory and interruption/retry tests prove that incomplete data is never published.

- [x] **14. Give application caches clear limits and ownership. Lower priority after the large costs.**

  [app/server.py](app/server.py) keeps `status_cache` and `organization_attempts` entries as the library grows. [app/jev.py](app/jev.py) limits judgment caches by entry count, not bytes. Search continuation windows already have count and serialized-size limits, but a 32 MiB JSON budget is not the exact size of the corresponding Python objects.

  Measure these caches before changing them. Remove redundant copies where the database already provides cheap status reads, prune entries for obsolete versions/deleted documents, and add byte-aware limits where measured payload sizes justify them. Keep one owner for each cache and explicit invalidation rules.

  Done when: cache sizes are observable and bounded for long-running use, without repeated expensive provider calls or stale results. These caches are not established as the cause of the original multi-GB footprint.

**Further research: six more tasks**

This second pass brings the plan to **20 tasks**. The new findings mostly reduce repeated work, temporary memory peaks, and browser work. They are not another measured multi-GB saving.

Three isolated probes exercised the existing functions with fake storage/database inputs and a tiny generated image. They did not open the live library or load models. [Probe script](outputs/memory-research/repeated_work_probe.py) and [results](outputs/memory-research/repeated-work-results.json).

| Probe | Observed result | Meaning |
| --- | --- | --- |
| Look up the newest upload receipt with 1,000 stored versions | 1 history-list call plus 1,000 metadata reads | The whole history is loaded before checking the first receipt. |
| Recover organization filters for 100 indexed documents twice | 100 update calls on each run | The second run still requests every update without checking for changes. |
| Four simultaneous requests for one uncached thumbnail | Four source reads and four entries into image generation | The cache does not combine requests while the first result is being generated. A later cached request adds no source read. |

These are **call counts, not timing or RAM measurements**. The thumbnail probe used PNG, not PDF; the PDF concurrency concern is also supported by reading the shared cache-miss path. The recovery probe counts calls to the update helper, not physical bytes written by LanceDB.

- [x] **15. Stop repeatedly processing files that keep failing. High priority when failures occur.**

  [app/server.py](app/server.py) `_cache_status`, `_worker`, and `reconcile_once` retain failed indexing IDs and try them again after a wait of up to 30 seconds. New work can wake the worker sooner. [app/ingest.py](app/ingest.py) `index_document` records many different exceptions as the same `failed` status. A damaged supported file can therefore repeat reading, conversion, or model work without anything changing.

  Track attempt count and next retry time for each document version. Increase the delay after repeated temporary failures, with a maximum delay. Pause automatic attempts for failures that require a different file or a configuration fix; provide an explicit retry. Reset the retry state for a new version. Persist enough information to avoid starting the same rapid retry cycle after every restart. A superseded queue item should resolve to the latest head.

  This is also needed for task 3: repeated failed jobs could keep the model active and prevent useful idle unloading. Keep original files downloadable and error messages visible.

  Done when: a damaged file stops causing frequent heavy work, temporary failures still recover, manual retry works, and a new version is processed promptly. Measure attempts and model loads during a ten-minute idle period with a failing file.

- [x] **16. Limit preview work and share an in-progress preview. High priority for memory peaks.**

  [app/ui.py](app/ui.py) `thumbnail` and `pdf_page` check their disk cache before doing heavy work, but only lock the final cache write. Several requests can all miss the cache and decode the same image or launch separate PDF renderer processes. The isolated thumbnail probe reproduced four generation paths for four identical requests.

  Add a small global preview-job limit, starting with a measured choice of one or two jobs. Requests for the same document/version/page should await one shared result. Bound the waiting queue too. Acquire capacity before reading file bytes or decoding pixels, and recheck the cache after acquiring it. Keep thumbnail and reader-page keys distinct. Avoid holding the global storage/index lock during rendering, and avoid making waiting previews consume the entire general request pool.

  These endpoints use Starlette's shared thread pool; its documented default allows [40 concurrent thread tokens](https://starlette.dev/threadpool/). That is not a suitable memory budget for PDF rendering, and it is not evidence that 40 renderers ran in our tests. Keep the existing renderer process isolation and timeout.

  Check the thumbnail PDF size from metadata before loading the complete file, as `pdf_page` already does. Reuse the verified version-pinned file from task 7 for successive page renders. Add a disk size/age limit for old derived previews; that part saves disk space, not necessarily RAM. Coordinate cleanup and document deletion with in-progress generation.

  Done when: identical concurrent requests produce one render, distinct requests respect the job limit, canceled/failed jobs release capacity, and peak memory is measured across the server and renderer children.

- [x] **17. Find upload receipts without loading every old version. Medium priority; high for frequently updated files.**

  [app/storage.py](app/storage.py) `save_file` calls `reversed(list_versions(...))` to detect retried uploads. `list_versions` eagerly reads every version's metadata through rocfl before the loop starts. Even a retry of the newest version performs all those reads. The isolated probe counted 1,000 metadata calls for 1,000 versions.

  Use a small, durable lookup from document/request ID to the committed version and receipt fields. Keep OCFL metadata authoritative: rebuild or repair the lookup after a missing cache or an interrupted commit. Record the head through which the lookup is complete so a cache miss cannot silently create a duplicate version. Validate the original content/metadata identity and keep the existing expected-version and deletion rules.

  Do not replace the scan with checking only the latest version: a legitimate retry can refer to an older upload. A lazy newest-first iterator is a smaller intermediate improvement for recent retries, but a brand-new request would still scan the whole history.

  Done when: normal updates and known retries avoid full-history reads after lookup recovery, and lost-commit-response, old-receipt retry, conflict, deletion, and restart cases remain correct. This mainly saves subprocess work, latency, and metadata allocation.

- [x] **18. Repair only organization filters that need recovery. Medium priority for startup and large libraries.**

  [app/server.py](app/server.py) `reconcile_once` calls [app/search.py](app/search.py) `recover_organization_filters` on startup and full rescans. That helper calls `_set_chunk_filters` for every document with chunks, even when nothing changed. The isolated probe requested 100 updates on each of two runs over the same 100 rows. The operation also holds the index lock while doing the repair pass.

  First measure clean-start duration, update calls, and derived table growth. Then use durable markers for interrupted organization publications, or compare stored filter revisions before updating. A recovery marker must be written before the multi-step update and cleared only after publication succeeds. Keep a full repair path for an old database, missing markers, or explicit integrity checks.

  Do not simply remove recovery or rely only on a clean-shutdown flag. Chunk filters and document rows can differ after a crash. Also keep the existing OCFL head reconciliation, which serves a different purpose.

  Done when: a clean restart performs no unnecessary filter updates, and simulated interruptions at each publication step still restore matching document/chunk filters. Memory savings are unmeasured; the clearest expected benefits are less startup work and shorter lock holds.

- [x] **19. Load document history and relationship details only when needed. Medium priority.**

  [app/ui.py](app/ui.py) `detail` always fetches evidence, connections, and every version. [frontend/src/components/DocumentInspector.tsx](frontend/src/components/DocumentInspector.tsx) requests this bundle even when opening the preview tab. This is separate from task 9's upload-status polling: ordinary inspector opens also pay the full cost.

  Return a small document summary first. Fetch paginated history when the history tab or version picker opens, and load larger evidence/relationship data when its visible section needs it. Preserve the small relationship summary shown in the preview, using a bounded response. Reuse the receipt/history work from task 17 instead of creating a second history cache.

  `connections` also rereads heads and filenames through rocfl while holding both the storage and index locks. Reuse one metadata result per identity within a consistent request. If slow reads move outside those locks, use snapshot/revision checks and final version validation before returning links. The existing `find_documents` path provides a useful pattern. Do not weaken freshness checks just to reduce calls.

  Done when: preview opens do not read the complete version history, history pagination and the version picker work, and relationships remain correct during upload/delete races. Measure request size, metadata calls, and time waiting for locks.

- [x] **20. Reduce work while moving around the document map. Lower priority; measure first.**

  [frontend/src/components/LibraryCanvas.tsx](frontend/src/components/LibraryCanvas.tsx) explicitly sets `onlyRenderVisibleElements={false}`. Edge construction also repeats node searches inside folder scans on each render, and `onMove` updates zoom state. Replace repeated lookups with a node-ID map and memoize edge results using the values they actually depend on. Avoid rebuilding expensive card content for every small zoom change when only a display threshold changes.

  Compare viewport-only rendering with the current behavior. React Flow documents [the option and its extra overhead](https://reactflow.dev/api-reference/react-flow), so turning it on is not automatically a win. The current map already takes at most 100 input documents, previews already load lazily, and node types are already declared outside the main component. This is not evidence of unlimited map growth.

  Done when: browser measurements show lower render cost or memory, and zoom, keyboard navigation, offscreen selection, folder containment, saved positions, and relationship edges still work. Preserve the existing tests that prevent cards blinking or losing measured size during refresh.

**How to keep these changes simple**

Group related changes around a few existing responsibilities: one model owner for tasks 1–3 and 6; one bounded conversion/preview workflow for 4–5 and 16; one version-pinned storage-read path for 7, 17, and 19; and small revision/status responses for 9, 11, and 12. Use separate limits for ingestion and interactive previews so one long import cannot block every preview. Task 15 belongs in the existing worker's retry policy.

Extract a helper when it removes repeated behavior or gives a resource one clear owner. Splitting large files into more files alone will not lower RAM. Avoid building a separate service or adding a new database for each task.

**Keep the parts that already work**

The app already has one ingestion worker, a bounded upload queue, protection against concurrent duplicate embedding construction, serialized embedding inference, and inference without gradients. Audio loading is already disabled. Browser content-card previews are lazy and capped at 200 cached entries; PDF preview object URLs are revoked. Preserve these behaviors.

Do not start by reducing vector dimensions: it reduces index size but does not remove model weights. Do not switch to float16 for EmbeddingGemma 2. Do not disable OCR or table extraction everywhere just to lower RAM; that would remove useful evidence. Do not add more server workers, each loading its own model, without measuring the combined footprint.

**Suggested order and completion checks**

First capture a repeatable whole-app baseline. Then implement 1–3 through one model manager, implement 4–5 together for ingestion, and tune 6 from measurements. Address large-file transfers and UI polling next. Include task 15 with idle unloading if failed jobs are present, and task 16 with preview/ingestion memory work. Use profiling to prioritize 10–14 and 17–20 for the actual library size; history and startup costs become more important as the library grows.

After each meaningful change, run the relevant functional tests and the same memory workload. Measure the browser, server, and all child processes separately and together. On this Mac, include process physical footprint and GPU allocations; RSS alone can miss important memory use. Record model-loaded memory, observed peak, memory after a job, idle memory, cold-search delay, warm search median/p95, and import time. Do not add overlapping GPU and process-accounting numbers as though they were independent pools.

The final workload should include repeated English/Hebrew searches, text uploads, real photos, scanned and text PDFs, multi-page tables, a long PDF, multi-frame images, large uploads/downloads, ZIP export, organization rebuilds, and several use/idle cycles. Test a search during ingestion, cancellation, process restart, and retry. Compare existing-index and rebuilt-index retrieval before a runtime migration. Select and record acceptable quality/latency thresholds before judging the new results.

Success means a clear reduction in idle and peak memory, acceptable speed, and preserved file/version/recovery behavior. There is no verified final RAM target yet, and the small synthetic tests do not prove 100,000-document capacity. Mark a task complete only after its implementation and checks pass.

**Implementation log — 17 October 2026**

The original files/library have not been used as benchmark fixtures. All new workloads use temporary OCFL/index directories; the cached model checkpoint is read-only. No applicable AGENTS.md was found in this repository or its ancestor directories. Existing work is untracked and has been preserved.

Implemented groups:

- Model owner (`app/embeddings.py`): serialized load/inference/unload, idle timer, text-only loading, vision replacement, compact float32 arrays, explicit torch CPU/CUDA/MPS behavior, unused pinned optional MLX conversion and index manifest guard. `scripts/prepare-mlx.py` records conversion settings and weight SHA-256. Legacy indexes cannot silently switch runtimes. The final user instruction selects 8-bit PyTorch without MLX; auto mode retains torch. `app/torch_quantization.py` implements bounded TorchAO conversion and token-row lookup; existing-index compatibility is explicitly measured before activation.
- Conversion/indexing (`app/conversion_worker.py`, `app/ingest.py`, `app/search.py`): path-based bounded-lifetime conversion child, OCR/table queues of 4 and stage batches of 1, page images disabled during conversion, one rendered page/frame at a time, scratch Arrow batches, inactive rows until complete publication.
- Transfers/previews (`app/storage.py`, `app/server.py`, `app/previews.py`, `app/ui.py`): verified version-pinned disk leases, range reads, staged-path upload finalization, streamed ZIP entries and HTTP ranges, durable receipt lookup with OCFL repair, two preview workers with a bounded/coalesced queue, preview disk limits and deletion rechecks.
- UI/data (`frontend/src/api.ts`, `hash.worker.ts`, `App.tsx`, `DocumentInspector.tsx`, `LibraryCanvas.tsx`, `app/organization_edits.py`, `app/rebuild.py`, `app/cache.py`, `app/jev.py`): incremental worker hashing, sliced uploads, prepared ZIP URL, revision polling, batched status reads, lazy paginated history, selected columns, one ordered evidence scan, narrow ledger reads, cursor/journal rebuild checkpoints, bounded judgment payloads and status bookkeeping, memoized map edges and node lookup.
- Retry/recovery (`app/retry.py`, `app/server.py`, `app/search.py`): durable per-version backoff/pause/manual retry and interrupted organization-publication markers.

Saved baseline: `baseline-app.json`, `baseline-models-app.json`, `baseline-tests.log`. The original Python suite produced 231 passes and one sandbox-only localhost binding failure; it is being rerun with socket access. The 16 MiB baseline used 64 range requests. Its median range latency was 75 ms. Baseline GPU access was unavailable, so CPU and Metal runs must not be presented as a matched speed comparison.

Focused recovery verification: **59 tests passed**, including HTTP startup, upload replay, deletion during indexing, and rebuild interruption. Final complete-suite and browser results are recorded below. The production adapters passed the existing synthetic English/Hebrew/image regression gate (minimum query cosine 0.998665; MLX queries against float32 documents: 41/48 top-1; images: 12/12). This is not representative production certification.

Measured data probes (`data_workload.py`, `data-workload.json`): 4,000 chunks / 128 sampled passages changed from 128 vector-bearing reads to one ordered selected-column scan, 1.038 s to 0.037 s and 3.55 MB to 0.155 MB of traced Python peak allocation. Eight reads of a 10,000-assignment ledger changed from 17.08 MB to 4.7 KB of traced allocation. Twenty library page calls took 227 ms versus 16 ms for the new progress response. These are isolated samples, not full-app/native memory totals.

The first real use/idle experiment found growing CPU footprint despite zero active GPU allocations. Reusing the tokenizer/image processor stopped that growth: the next three idle samples were approximately 1,156, 1,159 and 1,161 MiB. macOS malloc pressure relief provided no useful additional saving, so it has not been added to production. The tight 128 MiB MLX cache cap remains opt-in.

The completion record below supersedes the earlier pending-check notes. The live server was restarted and measured as requested; originals were preserved.

**Completion record — 17 October 2026**

**20 tasks complete under the revised PyTorch INT8 scope.** Tasks 3 and 6 were
reopened and then passed actual PyTorch lifecycle, server and native memory
checks. Task 1's original MLX proposal was replaced at the user's request. The
original float32 index is preserved, with a narrowly validated INT8 compatibility
receipt. The following table records final implementation and evidence.

| Task | Changed files and completion evidence |
| --- | --- |
| 1 | `app/torch_quantization.py`, `app/embeddings.py`, `pyproject.toml`, `uv.lock`, `.env.example`, `docs/memory-runtime.md`, `tests/test_torch_quantization.py`: pinned TorchAO 0.17.0, INT8 groups16/float32 text arithmetic, bounded conversion and row-only vocabulary decoding; vision bf16. MPS tested; explicit unquantized CPU/CUDA fallback. Manifest guards reject unsupported or unapproved switches. Existing-index 80-query approval: first-result agreement **100%**, top-three overlap **98.75%**, no expected-match losses. Rebuilt production-chunk semantic top-three **40/40 English, 28/40 Hebrew**; hybrid **39/40 English, 28/40 Hebrew**. Real photos **10/10** in both compatibility directions; scanned PDF and overlapping ingestion/search pass. Live originals/vectors unchanged. Full suite **273 passed**. See `followup/live-int8-approval.json` and `followup/summary.json`. |
| 2 | `app/embeddings.py`, `app/ingest.py`: text does not construct vision/image processor; serialized replacement releases text weights first. Real production adapters give identical full/text-only query vectors. Ownership/concurrency tests and real photo ingestion overlapping bilingual search pass (`overlap-workload.json`). |
| 3 | `app/embeddings.py`, `app/server.py`: one locked owner serializes inference, replacement and unloading. Concurrent load/unload/failure tests pass. Actual INT8 model-only three-cycle text idle **1,060 / 1,065 / 1,067 MiB**; final live idle **720 MiB**, matched isolated server **911 MiB**, all with zero active MPS tensors. Actual 60-second timer and clean shutdown verified; first live cold search **4.46 s**, warm median **386 ms**. These scopes differ and three cycles are not a long-run leak certification. |
| 4 | `app/conversion_worker.py`, `app/ingest.py`: bounded-lifetime Docling child, paths/scratch structure, timeout, parent-death guard and orphan cleanup; parent retains publication ownership. Real OCR preserves headings, tables and page1–2 text/visual evidence. Final actual INT8 scanned-PDF check passes bilingual first results and exact original SHA (`followup/torch-int8-real-pdf.json`); simultaneous physical peak **5.00 GiB**, with separate GPU accounting in `dense-int8-summary.json`. Conversion exits and releases models; child startup has latency cost. |
| 5 | `app/ingest.py`: no retained Docling page images, queues 4 and stage batches 1, one PDFium page/PIL frame decoded at a time and closed. Multi-frame cleanup test, real OCR provenance, and real-model 10/100/250-page runs pass. Complete document structure still scales with content; bounded pixels do not imply constant total memory. |
| 6 | `app/embeddings.py`, `app/ingest.py`: synchronize/clear at safe idle/heavy boundaries, release cached weights under the inference lock before image/PDF conversion, bound INT8 conversion temporaries and release page/frame batches. New child-order test passes. Repeated actual PyTorch cycles settle with zero active MPS tensors. Combined matched peak **6.06 → 3.98 GiB**; with preconversion unload fixed in both, float32→INT8 is **4.49 → 3.98 GiB**. Immediate post-unload samples overstate settled retention. Malloc pressure relief and per-small-query cache flushing were not added. |
| 7 | `app/storage.py`, `app/server.py`, `app/ui.py`: one verified version-pinned disk lease, streamed extraction/hash, range response, staged-path commit, streamed ZIP entries. Real 64 MiB browser upload/export checksum and 16 MiB/64-range workload pass. Repeated ranges extract the original once; active leases survive eviction; old bytes remain pinned after head changes. Existing interruption/restart/conflict/deletion tests pass. A response created before deletion still serves its pinned range, then removes the file at the last lease; new reads fail. Disk cache has size/age limits. |
| 8 | `frontend/src/api.ts`, `hash.worker.ts`, `App.tsx`, package lock, `app/ui.py`: incremental 1 MiB worker hashing, sliced upload/base64 chunks, prepared short-lived native ZIP URL and expiry cleanup. Whole-file File.arrayBuffer is forbidden in the real 64 MiB upload test; exact SHA/ZIP bytes pass. Paired fresh-Chrome hash measurement and full browser-native samples are saved. The application holds no full-file/ZIP buffer, but browser native memory is not zero and total native peak did not fall in the hash-only comparison. Hashing is slower in JS; see tradeoffs below. |
| 9 | `frontend/src/App.tsx`, `api.ts`, `app/ui.py`, `app/server.py`: compact revision/progress polls, hidden-tab pause, one in-flight poll, revision-keyed aggregates, batched statuses and identity-preserving ID lookup. Unchanged eight-second browser interval produced **zero full library reads**. Slow poll, revision churn, scope invalidation, drag during polls and measured-card no-blink checks pass. |
| 10 | `app/search.py`, `app/ui.py`: selected columns exclude vectors from metadata/evidence, preserve semantic/FTS score columns; one ordered Arrow scan samples the same IDs. **1.038 s → 0.037 s**, traced Python peak **3.55 MB → 0.155 MB** for 4,000 chunks / 128 samples. Search/retrieval suites pass. Table-open probe: 100 open/query calls **160 ms** vs reused handle **105 ms**; no new owner/cache was added because this does not establish memory savings or cached-handle freshness/concurrency. |
| 11 | `app/rebuild.py`, `app/server.py`: latest durable snapshot, narrow progress, cursor/roster, per-item fsynced journal with checkpoint identity, disk-spilled evidence profiles. Replay ignores torn tails; completed items remain replayable after checkpoint interruption. Recovery/retry/deletion tests pass. Whole control/data pipeline at **20 / 100 documents: 23.6 / 178.1 s**, **490 MiB** sampled peak; mid-run snapshot reload completed every document. Vectors/provider are fixtures and hosted latency is excluded. Preparation/clustering still scales; this is not a target-capacity claim. |
| 12 | `app/organization_edits.py`, `app/ui.py`: one latest bounded snapshot per directory, immutable narrow read views, copied editable payloads only. Concurrent readers cannot mutate shared state; atomic write/recovery tests pass. Eight 10,000-assignment reads changed traced allocation **17.08 MB → 4.7 KB** and **798 ms → 3.2 ms**. |
| 13 | `app/embeddings.py`, `app/ingest.py`, `app/search.py`: float32 arrays, bounded Arrow scratch batches, no full-document Python float expansion. Complete rows remain inactive until all batches validate and indexed-status/head gates pass. Interrupted Arrow batches never become searchable; stale-head/deletion/publication tests pass. |
| 14 | `app/cache.py`, `app/jev.py`, `app/server.py`: judgment/disagreement payload budgets **512 entries / 8 MiB each**, observable owned-byte counters, bounded status/attempt bookkeeping and deleted/obsolete-version pruning. Oversized entries can be declined without breaking the request. Fixture cache probe measured **14,760 bytes / 2 judgments**, **1,227 bytes / 1 comparison**, and repeated results used the cache with no extra provider call. These short fixtures do not establish production cache distribution or explain the original multi-GB footprint. |
| 15 | `app/retry.py`, `app/ingest.py`, `app/server.py`, `app/ui.py`, inspector: durable per-version exponential delay, permanent/configuration pause, explicit expected-version retry, new-head reset. Retry/restart/manual/new-version tests pass. During **603 seconds** of real idle with a permanently invalid file and repeated wakeups: **one attempt, zero model loads** (`failure-idle-final.json`). Originals remain downloadable. |
| 16 | `app/previews.py`, `app/ui.py`, server shutdown: two workers, eight waiting jobs, shared Future per preview identity, shielded waiter cancellation, final deletion check, bounded disk cache and shutdown drain. Eight identical requests rendered once; distinct requests peaked at two renderers, original extraction once. Eight rendered PDF pages took **1.07 s** and **163.5 MiB** simultaneous parent/child footprint. Concurrency/cancellation/failure/real-thumbnail tests pass. |
| 17 | `app/storage.py`: durable hashed request receipt + complete-through head, authoritative OCFL repair after missing/interrupted/partially lost lookup. Known old retries, expected-version conflicts, commit replay, partial-cache loss and deletion/restart tests pass. Twenty-version latest-receipt sample **956 ms → 90 ms**; ordinary lookup avoids historical metadata scans. New IDs inspect small receipt filenames to detect partial loss; recovery can still scan old metadata. |
| 18 | `app/search.py`: durable per-document interrupted-publication marker written before the multi-step update, legacy/full repair path retained. Repeated clean recovery performs **zero filter updates**. Existing failure-matrix and publication-recovery tests pass; OCFL head reconciliation still runs. No quantified RAM saving is claimed. |
| 19 | `app/ui.py`, `app/storage.py`, `DocumentInspector.tsx`: bounded summary, visible-section evidence/connections, newest-first history pagination pinned to head, version picker loads on focus/open; request-local metadata reuse. Historical/current bytes and repeated v2 evidence navigation pass in List/Cards/Canvas. Twenty-version sample: **23 → 3 metadata reads**, **6,173 → 1,130 JSON bytes**, **319 → 51 ms**. Uncontended lock hold was **20.1 → 19.7 ms**; no concurrent lock-wait improvement is claimed. |
| 20 | `LibraryCanvas.tsx`: memoized edges and node map; zoom state changes at content thresholds and movement end, preserving immediate CSS scale. Map navigation, containment, saved/manual positions, relationship strip, keyboard ownership, refresh and measured-size/content checks pass. On 100 documents, original/optimized/viewport-only page heap was **15.9 / 13.1 / 15.1 MB** and script duration **24 / 15 / 42 ms**; task/frame timings were mixed and noisy. Viewport-only rendered 27 cards but did not improve memory/script cost consistently, so final default remains false. The original-task-20 compiled comparison also reproduces the separate legacy geometry expectation failure. |

**Measured memory and latency**

Final PyTorch comparisons use the same five-document HTTP workload: English and
Hebrew text, a real photo, 16 MiB upload/download and a ten-page PDF. Inputs are
created outside measured server trees. Physical peaks include simultaneous child
charges, not the sum of each process's separate maximum.

| PyTorch configuration | Peak physical footprint | Idle after 66 s | Warm median | Reload after idle | PDF10 import |
| --- | ---: | ---: | ---: | ---: | ---: |
| float32 before preconversion unload | 6.06 GiB | 826 MiB | 177 ms | 408 ms | 8.42 s |
| float32 with preconversion unload | 4.49 GiB | 861 MiB | 186 ms | 417 ms | 8.89 s |
| INT8 with preconversion unload | 3.98 GiB | 911 MiB | 174 ms | 641 ms | 7.86 s |

The combined peak saving is **34%**; the quantization-only difference with the
same unloading fix is **11%**. INT8 reduces loaded text tensor storage from
**1,084,019,968 to 338,973,952 bytes**; scales add overhead. It does not improve
already-unloaded idle memory in every run. Reloading is slower in the matched
INT8 case. Initial live cold search includes first imports/model initialization
and is different from the table's reload timing.

The INT8 long-PDF sweep (before the final preconversion-unload fix) took
**12.11 / 41.65 / 116.06 s** for **10 / 100 / 250** sparse pages, with combined
workload peak **5.14 GiB**. The final dense two-page workload reached **5.00 GiB**.
These are observations, not constant-memory or worst-case bounds. The dense
probe records native RSS/physical footprint and per-process GPU active/driver
values separately; GPU maxima must not be added to physical charges or each other.

**Historical measurements below use their named configurations.** They remain
useful baseline/tradeoff evidence and do not describe the final INT8 live runtime.


- Matched CPU workload (bilingual text, image, 16 MiB transfer/ZIP): post-image
  physical footprint **3,207 → 1,324 MiB**, idle/unloaded **3,208 → 1,333 MiB**,
  about **58% less retained memory**. Warm search median **139 → 177 ms** and image
  import **7.19 → 17.76 s**: child startup and reload cost time. Baseline model load
  was eager; the new `get_embedder` is only a facade, so its near-zero construction
  time must not be compared as an equivalent model-load timing.
- Earlier optional MLX/Metal 10/100/250 sparse scanned pages: import **18.3 / 58.1 / 107.2 s**, sampled simultaneous
  parent+children physical peak **3,476 / 3,709 / 3,744 MiB**. These are similar peaks with
  more pages, not a constant-memory guarantee. Dense two-page OCR has a higher
  child peak; input complexity matters. No matched original MLX parent+children peak
  baseline exists for that historical experiment. The later matched PyTorch
  server comparison above establishes a reduction for its specified workload.
- Live three-cycle restart check: all **89 indexed documents** remained present;
  aggregate hashes of **272 OCFL inventory files** were identical. Physical
  footprint before restart was **3.59 GiB**, fresh idle **158 MiB**, and the third
  used/idle sample **1.21 GiB**. The old process's prior workload is unknown, so
  this is an observational live reduction, separate from the paired CPU workload.
  First cold search **10.52 s**; later reloads **1.55 / 1.70 s**. Seven warm samples
  per cycle had medians **1.05 / 0.80 / 1.17 s** and observed p95/max **1.22 / 1.07 /
  1.32 s**. Actual production 60-second idle expiry left **zero active MPS tensors**
  and about **0.69 MiB driver allocations**. Three cycles are not a long-run leak test.
- Browser 64 MiB hash in fresh Chrome: old **180 ms**, worker **1,305 ms**;
  main-page backing storage **67.9 → 3.9 MiB**. Native process charge peaked near
  **669 / 679 MiB**, then worker completion fell to **559 MiB**. Thus this removes
  an application-held full-file buffer and shifts work off the UI thread, but does
  **not** prove a smaller whole-browser native peak. An explicit ArrayBuffer
  detachment experiment showed no reliable improvement (**674 MiB** peak in its run) and was reverted; native peaks varied across runs.
  Actual uploads and native ZIP downloads have separate measurements and exact-byte
  checks in `browser-memory.json`; native browser buffering remains visible.
- GPU active/cache/driver values are reported separately and **never added to
  physical footprint**. RSS alone misses retained/compressed/unified allocations
  on this Mac. Parent/child peaks use simultaneous OS charges at 200 ms sampling;
  short spikes and subprocesses can be missed. Python tracemalloc figures exclude
  native Arrow/Lance/GPU allocations. Other applications were running during tests.

**Validation and remaining limits**

The final complete backend suite passed **273 tests in 312.98 seconds**
(`followup/full-tests.log`, `full-tests-result.json`), including 17 focused INT8
cases and concurrency, manifests, streaming, upload replay, expected-version
conflicts, old retries, interruption, process restart, deletion races, inactive
index publication and recovery checks. The final resource group has **23 passes**.
Actual image ingestion overlapping 12 bilingual searches, dense scanned-PDF
OCR/page evidence, exact original downloads and three use/idle cycles also pass.
Ruff and the production TypeScript/Vite build pass. Local sockets, Metal and Chrome
were exercised with the required OS access. No approval rejection remains.
CPU and MPS were tested; INT8 is supported here on MPS. CUDA and Intel macOS INT8
were not tested/supported; CPU/CUDA retain the explicit unquantized fallback.

All six earlier review8/10 browser failures now pass, with **21/21 related flows**
in `followup/browser-final.log`. Production fixes keep source sentences contiguous,
use 12px judgment labels, preserve legacy saved canvas geometry until explicit
reflow and keep opened search folders readable. No browser assertion was relaxed.
One intermediate mixed run had an Arrange/Undo failure; standalone, final mixed
and five additional repeated runs passed. That diagnostic remains recorded and
no speculative separate undo change was added. Broader historical failed runs
remain saved and are superseded only for the cases actually rerun.

Quality evidence uses the user-authorized generated bilingual labels, not an
independent production query set. The earlier manually split guide experiment
scored float32 **56/80 first / 62/80 top-three**; both float32 and MLX missed its
original absolute **90%** gate. The final release checks explicitly test precision
preservation through actual production chunking and the existing index; they do
not claim that historical absolute target passed. Through production chunking,
float32 semantic results are **36/40 first, 40/40 top-three English** and
**17/40 first, 28/40 top-three Hebrew**. Rebuilt INT8 gives **37/40, 40/40 English**
and **17/40, 28/40 Hebrew**. Hybrid and both precision-compatibility directions have
zero expected-match losses. The group64/bfloat16 candidate lost a Hebrew top-three
match and was rejected; group16/float32 was selected. The separate manually split
trial has small borderline losses recorded in its raw reports; those results
were not hidden or treated as a pass. Real-photo compatibility passes **10/10**
in both directions, minimum image cosine **0.999856**. Hebrew queries over English
technical guides remain a measured baseline limitation.

Existing-index validation ran with the old server stopped and the server lock
held. It preserved the original manifest and stored vectors, then atomically
recorded the exact approved encoder descriptor before changing the precision
flag. No fallback model is loaded silently. Unknown/corrupt descriptors or missing
approval fail closed. Unquantized fallback remains compatible with the preserved
live base manifest. Private filenames, query matches and contents are excluded
from saved validation reports.

The final live server is **PID 54272**, port **8765**, using **torch/INT8**.
The restart approval and subsequent read-only measurement preserved **89 indexed
documents** and all **272 OCFL inventory hashes**. Cold search **4.46 s**;
seven warm searches median **386 ms**, observed maximum/p95 **401 ms**; final
idle physical footprint **720 MiB**, **zero active MPS tensors** after the real
60-second timer. See `followup/live-int8-approval.json`, `followup/live-int8.json`
and `followup/summary.json`. This live run is observational; use the matched
isolated workload for before/after claims.

A 100,000-document capacity and sustained 16 GiB whole-system ceiling remain
unproven. Complex OCR still uses several GiB in its bounded child, and full rebuild
time scales with library size. Browser full-file buffering was removed from the
application, but the native browser hash benchmark did not show a total peak
reduction. Three idle cycles do not certify a long-running absence of leaks.
GPU accounting overlaps physical footprint; RSS alone is insufficient on this Mac.
No new malloc relief, tight cache budget, table owner or viewport-only map mode
was adopted without a measured benefit.

Reproduction commands, raw reports and scope:
[outputs/memory-research/REPRODUCE.md](outputs/memory-research/REPRODUCE.md),
[followup/README.md](outputs/memory-research/followup/README.md).
Runtime, fallback and compatibility instructions:
[docs/memory-runtime.md](docs/memory-runtime.md).
