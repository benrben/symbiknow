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

## Source references

`README.md`, `UI.md`, `app/server.py`, `app/storage.py`, `app/search.py`, `app/rebuild.py` and `tests/test_ui_api.py` define the operational behavior and regression coverage.
