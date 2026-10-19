# Independent implementation review — 17 October 2026

Reviewed the current implementation against all 20 tasks in
[Optimize-memory-symbiknow.md](../../../Optimize-memory-symbiknow.md).
The active implementation is PyTorch INT8, not the historical MLX proposal.
The starting backend code is in commit `f2b9c744`; the working tree also contains
later frontend/documentation/Jev changes. Those existing changes were preserved.

All new workloads use temporary libraries and generated/public fixture inputs.
The live server, its configuration, index and originals were not restarted or
migrated. Model files were read from the existing local cache. Hosted Jev calls
were disabled in native benchmarks and replaced with fixtures in tests.

## Problems reproduced and fixed

1. **A database transaction for every four embedding chunks.**
   `app/search.py:put_chunks` added each Arrow batch separately. A 4,000-chunk
   document created 1,004 table versions, including setup/index/activation work.
   It now streams bounded batches through one Arrow reader into one append
   transaction. Rows remain inactive until the complete stream succeeds;
   document status still gates publication. Producer exception types are
   preserved so retry classification does not change.

2. **Conversion input filenames could collide with worker output files.**
   `app/ingest.py:extract_units` used the user filename inside the scratch
   directory. Files named `stderr.log`, `document.json` or `result.json` could
   be truncated/overwritten by the worker, including through a symlink to the
   verified temporary original. Authoritative OCFL originals were not the
   overwrite target. The input now uses an internal name while retaining its
   extension; the document's display name remains the user's filename.

3. **Preview eviction could race a cache-hit read.**
   `app/ui.py` checked cached thumbnails/page metadata outside the lock used by
   cleanup. Another request could delete the JPG/JSON before it was read,
   producing `FileNotFoundError`. The cache check, metadata validation, bounded
   byte copy and pruning now share one locked helper. A newly rendered result
   is copied into its response before releasing the publication lock. Heavy
   decoding/rendering remains outside that lock, with the existing job limit.

[Nine regression cases](../../../tests/test_memory_review.py) cover one streamed
append, the three colliding filenames through both bytes and staged-path inputs,
and concurrent thumbnail/PDF-page eviction. All nine reproduced failures before
their respective fixes. See `regressions-before.log`, `preview-race-before.log`
and `resources-after.log`.

## Publication speed and memory

These are fresh-process, isolated **database publication** measurements with
synthetic 768-dimensional vectors, using the real Arrow spool and LanceDB.
They exclude model inference, OCR, HTTP and browser work. Physical footprint is
sampled every 20 ms and includes the Python process plus native libraries.

| Chunks | Before | After | Before process peak | After process peak | Table versions before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,024 | 1.028 s | 0.062 s | 126.2 MiB | 109.8 MiB | 260 → 5 |
| 4,000 | 2.528 s | 0.151 s | 359.5 MiB | 186.6 MiB | 1,004 → 5 |

The 4,000-chunk index occupied 74.8 MiB before versus 23.8 MiB after, including
derived table history. This does not compact previously created tables and
does not change OCFL history. The process starts near 95 MiB in both runs.
Single-run timings are local observations, not a guaranteed speedup. Other
tests/applications were active during parts of the measurements.

The unchanged baseline function is saved in `put_chunks_before.py`. Reproduce:

```sh
.venv/bin/python outputs/memory-research/implementation-review/chunk_benchmark.py before 4000
.venv/bin/python outputs/memory-research/implementation-review/chunk_benchmark.py after 4000
```

The pinned installed LanceDB implementation accepts a streaming Arrow reader;
its [official Python API](https://lancedb.github.io/lancedb/python/python/)
also documents Arrow batch inputs. No unbounded `read_all()` or complete vector
list was introduced.

## Coverage of the 20 tasks

| Tasks | Review and fresh verification |
| --- | --- |
| 1–3, 6 | Inspected descriptors, TorchAO conversion, text/vision ownership, inference/unload locks and timer lifecycle. Quantization and ownership regression tests included in backend suite; real-server measurements recorded separately below. |
| 4–5 | Inspected child timeout/parent-death handling, bounded PDF/frame iteration and preconversion unload. Added filename-collision coverage; existing child lifetime/frame cleanup tests pass. |
| 7–8 | Inspected verified-file leases, range reads, upload staging, incremental worker hashing and prepared ZIP downloads. Real 64 MiB browser upload/export passed exact-byte checks without allowing `File.arrayBuffer()`. |
| 9 | Revision/progress polling and pending-status batching reviewed. Browser tests pass unchanged-library, slow-poll and revision-churn checks. |
| 10 | Reviewed selected columns and ordered Arrow evidence sampling; search/retrieval tests included. |
| 11–12 | Reviewed rebuild journal replay/checkpoints and narrow organization snapshot accessors; recovery and immutable-reader tests included. The previous 100-document rebuild timing was not rerun. |
| 13 | Fixed tiny append transactions; measured real publication speed, physical memory and disk growth. Interrupted streaming still does not publish searchable chunks. |
| 14–15 | Reviewed cache budgets and durable version-specific retry state; cache, restart, new-head and retry tests included. The prior ten-minute failure-idle experiment was not rerun. |
| 16 | Fixed cache-read eviction races. Existing shared-preview, queue capacity, waiter cancellation and deletion tests included. |
| 17–18 | Reviewed receipt repair/completeness markers and interrupted filter-publication markers; old retries, partial receipt loss and clean recovery tests included. |
| 19 | Reviewed summary/evidence/history endpoints and paginated pinned history; lazy-history browser/API checks included. |
| 20 | Built the current frontend and measured the 100-document map. Drag/undo/saved viewport and refresh-without-blinking browser checks pass. |

## Browser and automated checks

- Initial full backend suite: **291 passed**, `backend-initial.log`.
- After all three fixes, focused resource/UI API suite: **74 passed**, `resources-after.log`.
- Frontend unit tests: **18 passed**, `frontend-units.log`.
- Selected browser flows: **6 passed**, `browser-isolated.log`.
- Production TypeScript/Vite build passed, `build.log`; Ruff passed, `ruff-final.log`.
- Final full backend suite after all fixes: **300 passed in 319.91 s**, `backend-final.log`.
- Native model benchmarks and dense scanned-PDF verification completed successfully.

The browser's 64 MiB upload took 5.72 s and native ZIP download/check took
0.54 s in this run. Eight seconds of unchanged browsing caused zero full-library
reads. During the old full-buffer hash, page backing storage was about 64.4 MiB;
after the streamed upload it was about 4.75 MiB. These are different workload
stages, **not a matched whole-browser peak comparison**. JS strings, worker and
native buffers still use memory. Raw native/heap samples are in
`browser-memory.json`; map samples are in `../map-implementation-review.json`.

The first browser attempt found port 8766 occupied and stopped without reusing
or stopping that server. The successful run used a new fixture on port 18766.
Test helpers now derive their origin/download URL from the test host, and the
memory report accepts an output path so historical measurements are preserved.

## Fresh whole-server measurements

The same isolated HTTP workload ran once in each precision: English/Hebrew
text, a real photo, an exact-byte 16 MiB transfer, a ten-page sparse PDF,
semantic searches, a real 66-second idle period and a search after unloading.
Both servers shut down cleanly. These compare **current float32 with current
INT8**, with the review fixes present in both. They are not a whole-app
before/after measurement of the three fixes above.

| Current runtime | Peak simultaneous server/child footprint | Idle after 66 s | Warm search median | Reload/search after idle | PDF10 import |
| --- | ---: | ---: | ---: | ---: | ---: |
| PyTorch float32 | 4.45 GiB | 1,271 MiB | 463 ms | 745 ms | 15.20 s |
| PyTorch INT8 | 3.98 GiB | 934 MiB | 448 ms | 1,289 ms | 18.62 s |

Both reported an unloaded model and **zero active MPS tensor bytes** after idle.
INT8 used less peak and settled idle memory in this pair. It did not make every
operation faster: reload and PDF import were slower. Warm-search differences
are too small/noisy here to establish a general speed advantage. Other tests
and applications were running during parts of the measurement.

Raw reports: [float32](../followup/server-none-implementation-review-bench.json)
and [INT8](../followup/server-int8-implementation-review-bench.json). Sampling
uses simultaneous physical charges at 200 ms, not the sum of separate process
maxima, and does not add GPU counters to physical footprint. Short spikes may
be missed. Sparse PDF results are not a memory ceiling for complex OCR.

```sh
SERVER_BENCH_PAGES=10 SERVER_BENCH_TAG=implementation-review .venv/bin/python outputs/memory-research/followup/server_precision_bench.py
.venv/bin/python outputs/memory-research/measure_tree.py outputs/memory-research/implementation-review/dense-pdf-tree.json -- .venv/bin/python outputs/memory-research/implementation-review/dense_pdf_review.py
```

The second command uses the prior dense-PDF probe copied into this directory
so historical results are not overwritten. It checks real OCR table/header
text, text and visual page provenance, English/Hebrew retrieval and original
SHA-256. **All these checks passed**: the expected document ranked first for
both the English and Hebrew query, and both text/visual evidence covered pages
1 and 2. The sampled simultaneous parent/child peak was **5.00 GiB**. This is
why the 3.98 GiB sparse-workload peak must not be presented as a maximum.
See [dense OCR result](torch-int8-real-pdf.json) and
[native process-tree samples](dense-pdf-tree.json). The two generated queries
are a focused smoke check, not broad retrieval-quality certification.

## Limits

This is a targeted implementation review and regression run, not proof that
every possible defect is absent. Existing 80-query compatibility reports were
read, not regenerated against the user's live index. Earlier large-library,
long-PDF, multi-cycle and quality results retain their original scope and date.
Native physical/GPU accounting overlaps; GPU counters must never be added to
process footprint. OCR peaks and full-app results must not be inferred from
the small database-only benchmark above.

Backend fixes are in the working tree and were exercised by fresh test processes.
The already-running live server was not restarted, so it will use them after
its next restart. No commit or live-library migration was performed.

Machine-readable results: [summary.json](summary.json), regenerated with:

```sh
.venv/bin/python outputs/memory-research/implementation-review/summarize_review.py
```
