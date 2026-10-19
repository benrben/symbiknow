# Symbiknow operations

Run one application owner for each data directory. The web app provides the human interface and a shared MCP endpoint; storage, indexing and organization remain separate outcomes for every uploaded file.

Symbiknow / Operations / Running and recovery

## Start and stop

For the built frontend, run `.venv/bin/python -m app.server --web` from the repository root. Open `http://127.0.0.1:8765` and connect agents to `http://127.0.0.1:8765/mcp`. `sh scripts/web.sh` installs frontend dependencies, builds and starts the same web mode. `--port` selects another port.

For development, `sh scripts/dev.sh` starts Uvicorn reload on 8765 and Vite on 5173. The scripts use the workspace Node runtime when available. The existing virtual environment can also run Uvicorn directly. Do not launch stdio mode while the web app owns the same data directory.

Use Ctrl+C for a clean shutdown and wait for the ingestion worker to finish before copying the data directory. Startup takes the process owner lock, initializes the OCFL repository, completes recorded deletion requests, removes derived rows for missing originals and starts reconciliation.

## Configuration

The project `.env` supplies configuration without overriding explicitly exported variables. `SYMBIKNOW_DATA_DIR` selects the library. `SYMBIKNOW_STORAGE_ONLY=1` disables indexing. `SYMBIKNOW_EMBEDDING_DEVICE` is `auto`, `mps`, `cuda` or `cpu`; `HF_HOME` selects the model cache. Optional chunk/file/page/conversion limits and model settings are listed in `.env.example`.

The configured `TYPESAFE_API_KEY` enables hosted Jev. Keep its actual value out of documents, import receipts and source control. Organization and evaluated search send selected text to TypeSafe. Local embedding and ordinary retrieval do not require a Jev answerability call.

## Indexing outcomes

Stored originals are the recovery source. Pending or failed current heads may be indexed again; that retry must not create another OCFL version. Unsupported files and empty extraction results are terminal indexing outcomes and remain downloadable. Native images without text can remain visually searchable while Jev organization is skipped.

A search miss immediately after upload may mean indexing is still pending. Inspect the per-file indexing state through MCP download or the Files view. Verify both the committed version and its status before claiming the file is searchable.

## Organization rebuild

The UI action Rebuild folders, groups and links supports the whole library or a folder including descendants. Folders/groups and links are independent selections. A grouping rebuild prepares one shared taxonomy before processing document memberships. It reuses stored embeddings and extracted evidence; it does not create versions or re-OCR solely for organization.

Requests persist in `data/temp/organization-rebuild.json`. Completion reports updated, skipped and failed items. Empty/unsupported outcomes are skipped with reasons. Preflight failure leaves organization intact. A full grouping reset clears captured folders, groups and manual assignments before rebuilding; failed/skipped selected documents stay Unfiled. Links-only retains folder placements, and grouping-only preserves valid links. Incoming links into a link-reset scope are cleared. Failed items can be retried with the prepared taxonomy and current heads. Clearing checkpoints every 32 items with idempotent interruption replay. Completion invalidates affected saved map layout and stale scope references while preserving unrelated layouts.

## Deletion

Delete folder removes the named folder and its descendants from organization, moving their documents to Unfiled while preserving original bytes, history, groups and links. Delete document permanently purges all versions and removes its search chunks and incoming links. Both operations use the UI's explicit confirmation; deletion waits for an active rebuild to finish.

Document deletion checks the latest expected version. Durable receipts in `data/temp/deleted-documents` finish an interrupted purge on startup and prevent an old upload replay from restoring the deleted identity. Review backup retention before treating permanent deletion as a recoverable action.

## Backup and restore

Stop the owner and copy the complete configured data directory to a separate backup location. Retain OCFL objects, derived index, temporary recovery receipts and required runtime/configuration material. On restore, start exactly one owner and verify current and historical downloads against their saved hashes before relying on retrieval.

A derived-index repair must preserve committed originals and version histories. `recover_organization_filters` repairs filters from document rows; `maintain_index` performs LanceDB maintenance while the daemon is stopped. A hard-killed native commit or power loss can still require OCFL validation or restoration; the current checks do not establish enterprise durability.

## Runtime and failed-index recovery

Preserve an existing library's runtime settings. The example selects tested MPS INT8; CPU/CUDA require `SYMBIKNOW_TORCH_QUANTIZATION=none`. Revision, precision, dimensions and preprocessing must match `index/embedding-runtime.json` or an explicitly measured compatibility receipt. Do not remove a manifest to bypass an error. `docs/memory-runtime.md` documents defaults and resource limits.

Index failures persist by version with exponential delays from 30 seconds to one hour. Permanent/configuration failures pause until corrected or explicitly retried. Retry indexing in the current-version inspector is guarded by the expected head and does not upload a new original. `GET /api/runtime` observes model ownership and initialized allocators without loading weights. GPU counters overlap process footprint.

Retain `organization-rebuild.jsonl` along with its JSON checkpoint when backing up. Rebuilding outcomes append fsynced checkpoint-bound journal records; clearing still checkpoints in batches of 32. The worker ignores torn/obsolete journal tails on recovery. Manual snapshots and filter-publication markers avoid repeated full-table work on clean reads/startup. Unfiled and connection reviews are alternatives to a full grouping reset; their browser summary history is not an audit log.

## Source references

`README.md`, `UI.md`, `app/server.py`, `app/storage.py`, `app/search.py`, `app/rebuild.py` and `tests/test_ui_api.py` define the operational behavior and regression coverage.

## Folder transfer receipts and exports
Folder MCP uploads preserve relative subfolders as manual assignments. Keep `temp/folder-uploads` with the durable library state: its UUID bindings and placement completion receipts prevent retries from duplicating files or undoing later manual moves. A stored file whose placement failed remains recoverable; retry the same request and bytes after the blocking organization job finishes. Individual upload receipts and original history remain authoritative for bytes.

`temp/folder-exports` holds up to four ten-minute ZIP snapshots, each with at most 1,000 files / 1 GiB of original bytes. These are temporary copies, not additional library documents. Subsequent folder-download calls clean expired files. Clients must use the same transfer ID across ranges, verify the whole archive hash, and restart if it expired. Prefer a smaller subfolder when export limits are reached.
