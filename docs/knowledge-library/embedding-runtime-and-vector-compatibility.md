# Symbiknow / Search / Embedding runtime and vector compatibility

Repository implementation guide. Snapshot: 12 October 2026.
## Model owner
The application uses one cached EmbeddingGemma 2 runtime, google/embeddinggemma-2. The adapter has a pinned default revision; an explicit environment override can select another revision. It does not silently substitute another embedding model when initialization fails.

## Device and representation
SYMBIKNOW_EMBEDDING_DEVICE supports auto, CPU, MPS or CUDA selection. Auto prefers CUDA, then available MPS, otherwise CPU. CUDA with supported bfloat16 uses that dtype; other selected paths use float32. Supported embedding dimensions are 128, 256, 512 and 768, with 768 as the default.

Documents use the adapter's title/text prefix. Queries use its task search-result query prompt. Native images use image inputs without a textual retrieval prefix. The adapter validates vector dimension and finite numeric values. A runtime lock prevents duplicate cached model construction and an inference lock serializes model calls.

## Operational effect
Index chunks record the embedding model. Vector retrieval filters for the compatible model identity rather than mixing unrelated spaces. A deliberate model or dimension change needs an index migration/rebuild plan and measured storage/query effects; changing a configuration string is not proof that existing vectors remain compatible.

Batching bounds inference inputs but does not establish total memory usage for a large library. Record actual hardware, dtype, dimensions, model revision and corpus/chunk counts in a performance report.

## Source references
- `app/embeddings.py`
- `app/ingest.py`
- `app/search.py`
- `pyproject.toml`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
