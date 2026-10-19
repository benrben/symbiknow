# Symbiknow / Architecture / Data ownership and system flow

Repository implementation guide. Snapshot: 12 October 2026.
## What owns the data
Symbiknow is one Python application with a shared human interface and MCP endpoint. Original bytes and per-version metadata belong to the OCFL repository managed through rocfl. LanceDB documents, chunks, vectors and organization are derived representations. React owns presentation state, including selection and saved canvas geometry; it is not the owner of original documents.

## Upload-to-answer flow
1. An MCP or browser upload sends actual bytes to the existing server.
2. Storage commits an OCFL version, then the server registers its current head and schedules ingestion.
3. One worker converts the committed original, chunks text, computes local embeddings and publishes current-version index rows.
4. Jev can choose folder/group metadata and version-pinned links using supplied textual evidence.
5. Retrieval returns current-version evidence; optional answerability adds judgments over that evidence.
6. Download reads the pinned original from OCFL and reports its SHA-256.

A storage commit can succeed before indexing or organization finishes. A failed model call does not erase the original. Reindexing and resetting organization are different operations and do not create content versions.

## Design boundary
The five public MCP tools are upload, download, search, upload_folder and download_folder. UI-only browsing, moving and confirmations use the same owner through local routes. There is no second graph database or fallback embedding runtime. Backups and recovery must distinguish irreplaceable originals from reconstructable indexes and durable operational receipts.

## Source references
- `app/server.py`
- `app/storage.py`
- `app/search.py`
- `docs/architecture.md`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.

## Folder transfers
Folder uploads reuse individual versioned original commits and durable manual assignments for relative subfolders. Folder downloads stream version-pinned original files into a bounded ZIP snapshot. `app/folder_transfer.py` coordinates these operations; the client supplies and receives actual bytes. Neither tool reads an arbitrary server-side directory path.
