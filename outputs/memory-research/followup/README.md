# Final PyTorch INT8 verification, 17 October 2026

All 20 tasks are complete under the user's revised scope: **8-bit PyTorch without
MLX**. TorchAO 0.17.0 stores text weights in symmetric INT8 groups of 16 with
float32 scales/arithmetic. Vision stays bfloat16. INT8 is tested on Apple M5 Pro
MPS; `SYMBIKNOW_TORCH_QUANTIZATION=none` is the explicit CPU/CUDA fallback. No MLX
run is part of this configuration. The interrupted MLX log is historical only.

The live server was restarted on port8765, PID54272. Its preserved float32 index
accepts the exact measured INT8 encoder through a compatibility receipt. Existing
vectors and originals were not rewritten. All 89 documents and 272 OCFL inventory
hashes survived. `live-int8-approval.json` records 80 bilingual existing-index
queries: first-result agreement100%, top-three overlap98.75%, minimum query
cosine0.999737, no expected-match losses. `live-int8.json` records cold4.46s,
warm median386ms (seven samples), and physical footprint720MiB after the real
60-second idle timer, with zero active MPS tensors. This is an observational live
run, not a matched comparison to the old process's unknown workload.

`summary.json` is generated from immutable raw artifacts by `summarize.py`.
The parent `implementation-summary.json` also retains explicitly historical
CPU/MLX results. Native physical footprint/RSS, simultaneous children and MPS
counters are separate: **never add GPU counters to physical footprint**.

| Same five-document HTTP workload | Peak physical footprint | Idle66s | Warm median | Reload after idle |
| --- | ---: | ---: | ---: | ---: |
| Float32 before preconversion unload | 6.06GiB | 826MiB | 177ms | 408ms |
| Float32 with preconversion unload | 4.49GiB | 861MiB | 186ms | 417ms |
| INT8 with preconversion unload | 3.98GiB | 911MiB | 174ms | 641ms |

This includes English/Hebrew text, a real photo, 16MiB exact-byte transfer and a
10-page PDF. Inputs are created outside measured process trees. Combined peak
improvement34%; INT8 alone after the same unloading fix11%. INT8 does not improve
already-unloaded idle in every sample. The before-fix INT8 sweep imported
10/100/250 sparse pages in12.11/41.65/116.06s; its combined peak was5.14GiB. Final
dense scanned-table OCR still peaked5.00GiB (`dense-int8-summary.json`). The
3.98GiB result is not a ceiling. Model-only three-cycle text-idle measurements
settled at1060/1065/1067MiB (`torch-cycles-int8.json`); this scope excludes OCR,
server, browser and database. Immediate unload readings overstate settled memory.

Backend: **273 passes**, `full-tests.log`, including17 focused INT8 cases and
concurrency, retries, stream leases, replay, recovery and deletion/publication
races. Resource subgroup23passes; Ruff and production build pass. Related browser
flows **21/21 pass**, including all six earlier layout/excerpt failures, without
relaxing assertions. An intermediate Arrange/Undo failure remains saved; the
standalone, final mixed and five repeated runs passed. No speculative undo fix
was made. Frontend changes preserve contiguous excerpts, readable judgment labels,
legacy saved canvas geometry and opened search-folder readability.

Quality through actual production Docling chunking and LanceDB:54 guides,
343 chunks,80 generated bilingual queries. INT8 semantic expected top-three
40/40 English,28/40 Hebrew; hybrid39/40 English,28/40 Hebrew. Existing float32
queries against rebuilt INT8, and INT8 against original production float32
chunks, lose zero expected matches. Public real photographs pass10/10 both
compatibility directions; dense PDF evidence preserves headings/table/pages and
exact bytes;12 bilingual searches overlapping image ingestion pass.

These labels were generated with user authorization; they are not independent
production certification. The earlier manually split141-passage float32 baseline
missed its absolute90% top-three goal. That failure remains recorded; final gates
explicitly test precision preservation, not a claim that baseline retrieval has
been solved. Rejected group64/bfloat16 loses a production Hebrew result. Small
borderline manual-passage regressions are retained in group16 trial reports.
No 100000-document capacity, long-run leak certification or sustained16GiB
whole-system ceiling is established. Other applications ran during measurement.

From the project root, with the locked environment and cached checkpoint:

```sh
.venv/bin/python -m pytest -q
.venv/bin/ruff check app tests
PATH="$PWD/.tools/node/bin:$PATH" npm --prefix frontend run build
SERVER_BENCH_PAGES=10 SERVER_BENCH_TAG=reproduced10 .venv/bin/python outputs/memory-research/followup/server_precision_bench.py
SYMBIKNOW_TORCH_QUANTIZATION=none .venv/bin/python outputs/memory-research/followup/torch_cycles.py
SYMBIKNOW_TORCH_QUANTIZATION=int8 .venv/bin/python outputs/memory-research/followup/torch_cycles.py
SYMBIKNOW_EMBEDDING_RUNTIME=torch SYMBIKNOW_TORCH_QUANTIZATION=int8 QUALITY_COMPARE_FLOAT32=1 QUALITY_LABEL=reproduced-guide-int8 TYPESAFE_API_KEY='' .venv/bin/python outputs/memory-research/followup/production_guide_quality.py
.venv/bin/python outputs/memory-research/followup/torch_int8_real_pdf.py
SYMBIKNOW_EMBEDDING_RUNTIME=torch SYMBIKNOW_TORCH_QUANTIZATION=int8 OVERLAP_RESULT=followup/reproduced-overlap TYPESAFE_API_KEY='' .venv/bin/python outputs/memory-research/overlap_workload.py
.venv/bin/python outputs/memory-research/followup/torch_int8_adapter_check.py
.venv/bin/python outputs/memory-research/followup/summarize.py
.venv/bin/python outputs/memory-research/summarize_results.py
```

Run sequentially; workload data is isolated and temporary. `regular_measurements.py`
and `torch-pdf*-app/tree.json` retain the earlier float32 harness sweep; those
inputs were created inside the harness, unlike the final actual HTTP benchmark.
The guide check uses inline Markdown conversion and is a retrieval check, not a
child-lifetime memory measurement. To measure dense OCR with separate GPU samples:

```sh
PYTHONPATH="$PWD/outputs/memory-research/followup/native-telemetry:$PWD" SYMBIKNOW_MEMORY_SAMPLE_DIR="$PWD/outputs/memory-research/followup/reproduced-dense-gpu" .venv/bin/python outputs/memory-research/measure_tree.py outputs/memory-research/followup/reproduced-dense-tree.json -- .venv/bin/python outputs/memory-research/followup/torch_int8_real_pdf.py
```

The observer is benchmark-only, does not import torch or synchronize, and records
numeric per-process values. Supervision process overhead is excluded from the
measured child tree. It is not enabled in the production server.

Browser reproduction from `frontend/` (fixture ports8766/5174 must be free):

```sh
PATH="$PWD/../.tools/node/bin:$PATH" npm run build -- --outDir dist-memory-followup
PATH="$PWD/../.tools/node/bin:$PATH" SYMBIKNOW_UI_BUILD="$PWD/dist-memory-followup" npm test -- tests/review8.spec.ts tests/review10-ui.spec.ts tests/ui.spec.ts tests/zz-desktop.spec.ts tests/compact-desktop.spec.ts --grep 'legacy124|generated112|pinnedREADME|many folders|revision churn|slow library poll|repeated samebadge|reference screens|canvas previews|positions and viewport survive|background refresh never hides|canvas drag|changed folder parents|Quick Look|bulk uploads|HTML preview'
PATH="$PWD/../.tools/node/bin:$PATH" SYMBIKNOW_UI_BUILD="$PWD/dist-memory-followup" npm test -- tests/zz-desktop.spec.ts --grep 'canvas drag' --repeat-each 5
```

Only `approve_live_torch_int8.py` and `../restart_and_measure.py` deliberately
access the live library. Do not casually rerun them or reuse stale PIDs. The
approval helper checks exact owner identity, idle state and prerequisite gates,
stops the owner, holds server.lock, reads the frozen existing index, records proof
atomically, changes only the precision flag, and restarts. Failure keeps/restores
float32. The separate measurement supports `--measure-only`, reads eight bilingual
queries with evaluation off, waits66s and checks inventories. No live fixture
uploads, deletion or rebuilds are performed. Reports retain no private filenames,
bodies or query matches. Review assertions for a different library or platform.
