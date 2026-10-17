# Memory verification, 17 October 2026

Current selection: **8-bit PyTorch, without MLX**, per the user's final
instruction. The live server was validated and restarted with
`SYMBIKNOW_EMBEDDING_RUNTIME=torch` and `SYMBIKNOW_TORCH_QUANTIZATION=int8`.
All 20 tasks are complete under this revised scope. See
[followup/README.md](followup/README.md) for current matched HTTP benchmarks,
quality checks, final 273 backend/21 browser passes and live compatibility proof.
The aggregate reports are regenerated with:

```sh
.venv/bin/python outputs/memory-research/followup/summarize.py
.venv/bin/python outputs/memory-research/summarize_results.py
```

The commands below retain historical work. MLX commands/results are unused
research; do not run them for the active configuration. Explicitly set
`SYMBIKNOW_TORCH_QUANTIZATION=none` for historical unquantized PyTorch comparisons.

All workloads except the explicitly named `restart_and_measure.py` and
`followup/approve_live_torch_int8.py` use temporary,
isolated data. Do not point those workloads at the user's library. Model assets
are read from `data/models`; no benchmark changes them. The initial repository was
untracked; the baseline reports are captured executions, not a committed before
checkout. Inputs and sampling scripts are retained for matched workload reruns.

From the project root, using the locked environment:

```sh
.venv/bin/python -m pytest -q
.venv/bin/python -m pytest tests/test_memory_improvements.py -q
.venv/bin/ruff check app scripts/prepare-mlx.py tests/test_memory_improvements.py
PATH="$PWD/.tools/node/bin:$PATH" npm --prefix frontend run build
.venv/bin/python outputs/memory-research/data_workload.py
.venv/bin/python outputs/memory-research/detail_workload.py
.venv/bin/python outputs/memory-research/table_open_probe.py
.venv/bin/python outputs/memory-research/cache_probe.py
.venv/bin/python outputs/memory-research/measure_tree.py outputs/memory-research/rebuild-tree.json -- .venv/bin/python outputs/memory-research/rebuild_workload.py
.venv/bin/python outputs/memory-research/measure_tree.py outputs/memory-research/ocr-evidence-tree.json -- .venv/bin/python outputs/memory-research/ocr_evidence.py
.venv/bin/python outputs/memory-research/failure_idle.py
```

The failure-idle probe deliberately runs ten minutes. Full rebuild measurements
use actual OCFL/LanceDB and the complete control/data path, but deterministic fixture
vectors/provider decisions. They exclude hosted provider latency and ingestion.
The OCR probe uses real Docling on a generated two-page scanned table.

The prepared optional runtime in this workspace is
`outputs/memory-research/mlx-runtime`; the checked 8-bit artifact is
`outputs/memory-research/quantization/model-8bit`. Historical isolated installation used `uv pip install --target
.tools/mlx-runtime --no-deps mlx==0.32.3 mlx-metal==0.32.3` plus
`mlx-vlm @ git+https://github.com/Blaizzy/mlx-vlm@3d87e88402f307efbf68e568971aa887ee7d9ed0`,
then `scripts/prepare-mlx.py` with the isolated PYTHONPATH and cached checkpoint.
These instructions are retained for provenance only. For the earlier Metal
measurements, the environment was:

```sh
export HF_HOME="$PWD/data/models"
export PYTHONPATH="$PWD/outputs/memory-research/mlx-runtime"
export SYMBIKNOW_MLX_MODEL="$PWD/outputs/memory-research/quantization/model-8bit"
.venv/bin/python outputs/memory-research/runtime_quality.py
.venv/bin/python outputs/memory-research/generated_quality.py
.venv/bin/python outputs/memory-research/torch_fallback_compatibility.py
export SYMBIKNOW_EMBEDDING_RUNTIME=mlx
.venv/bin/python outputs/memory-research/idle_cycles.py
.venv/bin/python outputs/memory-research/measure_tree.py outputs/memory-research/overlap-tree.json -- .venv/bin/python outputs/memory-research/overlap_workload.py
.venv/bin/python outputs/memory-research/measure_tree.py outputs/memory-research/pdf10-final-tree.json -- .venv/bin/python outputs/memory-research/app_workload.py after-mlx-pdf10-final --models --pdf-pages 10
```

Repeat the last command with 100/250 pages and distinct output labels to compare
page counts. `app_workload.py` covers bilingual text, search, 16 MiB transfer in 64
ranges, ZIP, library reads, an image and optional PDF. It imports test/Docling
helpers, so its initial footprint is larger than the minimal web server. For a
CPU comparison, unset the optional MLX runtime selection and set
`SYMBIKNOW_EMBEDDING_DEVICE=cpu`. Baseline CPU and new Metal timing are not paired.

Browser tests run from `frontend`, with `.tools/node/bin` in PATH:

```sh
cd frontend
PATH="$PWD/../.tools/node/bin:$PATH" npm test -- tests/memory.spec.ts tests/hash-memory.spec.ts
PATH="$PWD/../.tools/node/bin:$PATH" npm test -- tests/zz-desktop.spec.ts tests/review-fixes.spec.ts --grep 'historical Details|canvas drag|background refresh never hides'
```

`memory.spec.ts` uses a real 64 MiB upload and ZIP extraction/hash verification;
fixture server 8766 owns a temporary library. The hash comparison uses fresh Chrome
processes and Vite 5174, with identical bytes. `browser-hash-detach-experiment.json`
is the discarded buffer-detachment alternative. Native peak was not improved.

Map artifacts compare the saved original task-20 component (`map-before.json`),
optimized default (`map-all.json`), and the optional build setting
`VITE_VISIBLE_MAP=1` (`map-visible.json`) on 100 identical fixture documents.
The final build uses the existing false setting. Concurrent machine activity adds
noise; these are samples, not latency percentiles or universal performance claims.

macOS sampling uses `proc_pid_rusage` physical footprint and `ps` RSS, every 200 ms
for command trees. It sums simultaneous process charges, not independent per-process
peaks. Very short subprocesses/spikes can be missed. GPU allocator/driver numbers
are reported separately because they overlap process footprint. Browser main-page
JS heap does not include native/worker memory; explicit Chrome process IDs are
sampled too. Other unrelated apps are excluded.

`restart_and_measure.py [OLD_PID] [CYCLES] [OUTPUT_JSON]` is intentionally a **live**
restart tool. It validates the exact Symbiknow command, requires an idle nonempty
library, uses graceful SIGINT, waits for the owner to exit, restarts port 8765,
then performs read-only bilingual searches and real 66-second idle periods.
It compares aggregate hashes of all OCFL inventory files before/after. Do not run
it casually on a different library or PID; review its assertions first. It retains
no private filenames, bodies or search results. `--measure-only` as a fourth argument observes the existing exact owner without
another restart. Live-before workload is unknown,
so the live reduction is observational rather than a paired workload result.
