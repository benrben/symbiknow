# Symbiknow / Search / Embedding runtime and vector compatibility

Repository implementation guide. Snapshot: 17 October 2026.
## Model owner
One serialized model manager owns google/embeddinggemma-2 at revision `2c791de4ddbe5cabd592cc93692f7acb67e52555`. A different `SYMBIKNOW_EMBEDDING_REVISION` is rejected. `auto` selects the regular PyTorch runtime; the optional MLX adapter is research code and is not the selected live runtime. Initialization failures remain explicit.

## Device and representation
SYMBIKNOW_EMBEDDING_DEVICE supports auto, CPU, MPS or CUDA selection. Auto prefers CUDA, then available MPS, otherwise CPU. With quantization `none`, supported CUDA uses bfloat16 and CPU/MPS use float32. The example configuration selects `SYMBIKNOW_TORCH_QUANTIZATION=int8`, supported on tested Apple Silicon MPS only. Pinned TorchAO 0.17.0 compresses text weights into symmetric groups of 16 with float32 arithmetic/scales; vision remains bfloat16. CPU/CUDA must select `none`. Supported embedding dimensions are 128, 256, 512 and 768, with 768 as the default.

Documents use the adapter's title/text prefix. Queries use its task search-result query prompt. Native images use image inputs without a textual retrieval prefix. The adapter validates vector dimension and finite numeric values. A single model owner serializes loading, inference, text/vision replacement and unloading. Text-only work excludes vision; image work replaces the text-only weights under that owner. The default 60-second idle timeout releases weights after active inference finishes. Heavy image/PDF conversion releases cached weights before its child starts.

## Operational effect
Index chunks record the embedding model. Vector retrieval filters for the compatible model identity rather than mixing unrelated spaces. A deliberate model or dimension change needs an index migration/rebuild plan and measured storage/query effects; changing a configuration string is not proof that existing vectors remain compatible.

Batching bounds inference inputs but does not establish total memory usage for a large library. Record actual hardware, dtype, dimensions, model revision and corpus/chunk counts in a performance report.

## Index compatibility

`index/embedding-runtime.json` binds revision, runtime, precision, dimensions, preprocessing and package descriptors. Precision changes fail closed unless a measured compatibility receipt explicitly approves the requested encoder. The live float32 index has a validated INT8-query receipt; this is not automatic approval for other libraries or the reverse precision switch. Preserve the original manifest and vectors. See `docs/memory-runtime.md` for migration boundaries, fallback and measured results.

## Source references
- `app/embeddings.py`
- `app/ingest.py`
- `app/search.py`
- `pyproject.toml`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
