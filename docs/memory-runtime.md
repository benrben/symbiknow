# Memory runtime controls

The selected runtime is **8-bit PyTorch, without MLX**. The live library was
checked before activation and the server restarted on 17 October 2026. Use the
locked environment, including `torchao==0.17.0`:

```dotenv
SYMBIKNOW_EMBEDDING_RUNTIME=torch
SYMBIKNOW_TORCH_QUANTIZATION=int8
SYMBIKNOW_MODEL_IDLE_SECONDS=60
```

The tested 8-bit platform is Apple Silicon macOS with MPS (Apple M5 Pro).
Text weights use symmetric INT8 groups of 16 with float32 scales and arithmetic;
this is weight compression, not a promise of native INT8 compute kernels. Token
lookups decode only requested rows. Weight conversion uses at most 2,048 rows at
a time. Vision remains bfloat16, loads only for image work, and temporarily
replaces the text-only model. Audio stays disabled. One model owner serializes
inference, replacement and unloading. Heavy image/PDF conversion releases cached
embedding weights before starting its bounded child process.

For the supported unquantized fallback, set
`SYMBIKNOW_TORCH_QUANTIZATION=none` and restart. CPU/MPS use float32; CUDA uses
bfloat16 where supported. CPU and MPS were exercised here; CUDA was unavailable.
The INT8 path rejects unsupported devices, missing/wrong TorchAO versions and
incompatible indexes before loading weights. It does not silently create another
model or switch precision. `auto` selects torch; quantization defaults to `none`
when the flag is absent. The example opts into the tested MPS configuration.

Every new index records its runtime, pinned model revision, precision,
dimensions and preprocessing in `index/embedding-runtime.json`. An existing
float32 index requires explicit compatibility evidence before accepting INT8
queries. The live check compared 80 generated bilingual queries against the
actual existing index: identical first results, 98.75% top-three overlap and no
expected-guide losses. Separate production-chunk, image, PDF and resource checks
also passed. `index/embedding-runtime-compatibility.json` records that measured
approval atomically; the original manifest, stored vectors and OCFL originals
remain unchanged. A missing, corrupt or mismatching receipt fails closed.

The preserved float32 manifest allows the live library to fall back to `none`.
A newly created INT8 index cannot assume compatibility with float32 queries:
validate a separate derived index before changing its precision. Never erase a
manifest to bypass the guard. The live approval script under
`outputs/memory-research/followup/` is a one-off, guarded experiment, not a general
migration command for arbitrary libraries. Generated labels are not independent
production certification; Hebrew queries over English guides remain less accurate
than English queries. Historical MLX experiments remain unused research.

Other resource settings and defaults:

- `SYMBIKNOW_MODEL_IDLE_SECONDS=60`: positive idle timeout; zero disables it.
- `SYMBIKNOW_TRANSFER_CACHE_BYTES=1073741824` and
  `SYMBIKNOW_TRANSFER_CACHE_SECONDS=3600`: verified, version-pinned disk cache.
- `SYMBIKNOW_PREVIEW_CACHE_BYTES=268435456` and
  `SYMBIKNOW_PREVIEW_CACHE_SECONDS=604800`: derived preview disk cache.

Preview work has two workers and eight waiting slots; identical requests share
one render. Conversion runs in a bounded-lifetime child per job. Permanent
failures pause; transient failures back off from 30 seconds to one hour. The
inspector offers Retry indexing for a failed current version.

Idle expiry unloads only after inference finishes, synchronizes the device and
clears unused allocator cache. Physical footprint can take a few seconds to
settle. The next search includes model loading. Around 1 GiB describes settled
idle memory, not loaded-model or OCR peak memory: the matched server/child peak
fell from 6.06 to 3.98 GiB, while the dense scanned-PDF run still reached 5.00 GiB.
No per-query cache flush or malloc-pressure-relief workaround was added.

`GET /api/runtime` observes ownership and already initialized GPU allocators
without loading weights. GPU allocator/driver memory overlaps macOS physical
footprint: never add the two. Benchmarks record physical footprint, RSS, child
processes and GPU values separately. Browser JS heap excludes native/worker
memory. See the task document and `outputs/memory-research/followup/README.md`
for measured results, limitations and reproduction commands.
