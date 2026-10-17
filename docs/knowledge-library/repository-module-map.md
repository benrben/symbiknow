# Symbiknow / Architecture / Repository module map

Repository implementation guide. Snapshot: 12 October 2026.
## Backend ownership
| Module | Main responsibility |
| --- | --- |
| app/server.py | MCP tools, scheduling, owner lifecycle and transfer status. |
| app/storage.py | Native rocfl originals, metadata, version conflicts and purge receipts. |
| app/ingest.py | Conversion, chunking, text/visual embeddings and version-checked publication. |
| app/embeddings.py | The cached EmbeddingGemma 2 adapter. |
| app/search.py | LanceDB schema, retrieval, filters, current-head checks and maintenance. |
| app/organization.py | Content candidates, project scope and bounded topic preparation. |
| app/jev.py | Hosted evidence-bound organization and answerability decisions. |
| app/rebuild.py | Durable selective clearing/rebuilding and retries. |
| app/organization_edits.py | Persistent manual overrides and recoverable metadata edits. |
| app/relationships.py | Canonical symmetric relationship presentation. |
| app/ui.py | Local HTTP routes, original delivery, cards, thumbnails and bulk ZIP. |
| app/evaluation.py | Label-agnostic per-class and pairwise evaluation metrics. |

## Frontend and support code
App.tsx holds shared navigation, search, selection and version state. Sidebar, SearchBar, FileList, LibraryCanvas and DocumentInspector are the major surfaces. ContentCard fetches bounded representations. Markdown centralizes safe GFM rendering. presentation.ts manages optional preferences and scope-aware invalidation. OrganizationDialog, ResetOrganizationDialog and DeleteDialog provide explicit actions.

client.py is an official MCP SDK transfer helper. scripts contains run, validation, benchmark and evaluation entry points. tests contains isolated storage/MCP/retrieval/UI regressions and deterministic fixtures. docs holds developer guides and operational receipts. frontend/dist is a generated build, not a separate application owner.

## Source references
- `app/server.py`
- `app/ui.py`
- `app/organization_edits.py`
- `app/evaluation.py`
- `frontend/src/App.tsx`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
