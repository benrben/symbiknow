# Symbiknow / Operations / Configuration dependency and secret boundaries

Repository implementation guide. Snapshot: 17 October 2026.
## Configuration owner
The app loads local environment configuration. SYMBIKNOW_DATA_DIR selects the library and SYMBIKNOW_STORAGE_ONLY disables indexing. Model/device/dimension, transfer limits, conversion limits and hosted-provider selection have explicit configuration points. Read .env.example and current source for defaults without copying a real .env into documentation.

## Local and hosted processing
EmbeddingGemma 2 performs local text/query/image embeddings. TYPESAFE_API_KEY enables hosted Jev organization and evaluated search. Selected document text is sent to that provider. Turning off the UI answerability switch does not disable background organization. Ordinary keyword retrieval does not itself need a Jev answerability call.

## Reproducible dependency inputs
Python requires the range declared in pyproject.toml and pinned runtime dependencies resolved by uv.lock. The frontend uses React/TypeScript/Vite, React Flow, Radix, Lucide, React Markdown/GFM and DOMPurify; package-lock.json records resolved frontend dependencies. The current workspace uses a bundled Node runtime, while other hosts must supply a compatible runtime.

## What not to import
Real .env contents, private API tokens, model cache blobs, virtual environments, node_modules, OCFL inventories, raw derived indexes and fictional QA fixtures are not project knowledge documents. Import the selected repository guides and dated media, retaining source paths/hashes and licenses. The two OCFL standards are deliberately excluded from the current live refresh, as recorded in `docs/project-library.md`.

Configuration examples must use placeholders. Error reporting should sanitize provider exception bodies rather than accidentally revealing uploaded passages or credentials.

## Runtime controls

Exported variables take precedence over `.env`. The example selects PyTorch INT8 on MPS, while absent quantization configuration defaults to `none`; CPU/CUDA require the unquantized setting. Runtime manifests guard compatibility. Idle timeout, transfer/preview cache size/age, conversion timeout/page limits and maximum file/chunk sizes are independent settings. See `.env.example` and `docs/memory-runtime.md`. The pinned checkpoint cannot be changed through an arbitrary revision override.

## Source references
- `pyproject.toml`
- `frontend/package.json`
- `app/server.py`
- `app/embeddings.py`
- `app/jev.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
