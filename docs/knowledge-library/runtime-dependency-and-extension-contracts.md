# Symbiknow / Architecture / Runtime dependency and extension contracts

Repository implementation guide. Snapshot: 12 October 2026.

## Python responsibilities
The runtime dependencies include the official MCP SDK, file/process locking, dotenv configuration, TypeSafe SDK, LanceDB/PyArrow, Docling, the SentenceTransformer/Transformers/Torch stack, Pillow and Starlette/Uvicorn. pyproject.toml declares the supported Python range and uv.lock resolves the environment.

## Frontend responsibilities
React/TypeScript/Vite provide the existing SPA; React Flow owns canvas interactions. Radix supplies accessible primitives, Lucide icons, React Markdown plus remark-gfm structural reading, and DOMPurify protects HTML previews. package-lock.json is the frontend resolution record.

## Safe extension points
Add project behavior through the existing owner, shared state and derived representation paths. Do not add a second storage owner or advertise a fourth MCP tool for a UI-only action. Keep public upload/download/search byte and evidence contracts compatible. Native storage is delegated to the checked rocfl binary; embeddings do not silently switch providers/models on failure.

## Change verification
A dependency/configuration change needs its own compatibility check: SDK schema behavior, original-byte round trips, stored-vector dimensions and frontend build behavior are distinct. The current pinned files describe this repository snapshot, not the latest external package releases.

## Source references
- `pyproject.toml`
- `frontend/package.json`
- `app/server.py`
- `app/embeddings.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
