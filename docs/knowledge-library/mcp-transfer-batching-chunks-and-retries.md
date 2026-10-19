# Symbiknow / Storage / MCP transfer batching chunks and retries

Repository implementation guide. Snapshot: 17 October 2026.
## Connect to the existing owner
The web app exposes http://127.0.0.1:8765/mcp. Use the installed official MCP SDK Client with that URL and discover list_tools before transferring. The public tools are upload, download, search, upload_folder and download_folder. client.py's reusable helpers can use the HTTP session; its CLI uses `--url` for the existing HTTP owner, or starts an alternative stdio owner when omitted.

## Upload contract
upload receives files with filename and content_base64. Supply source, MIME type and a UUID request_id for provenance and idempotent retries. A bulk call accepts 1–32 items; each item has its own result. The reusable client intentionally groups at most two small files to keep messages bounded.

Default limits are 262,144 raw bytes per chunk and 268,435,456 bytes per file. Larger transfers provide offset, total_size, whole-file SHA-256 and final on the last chunk. Reuse identical request IDs and metadata across a retry; changing them changes the operation. An update supplies document_id and expected_version.

## Download contract
Each request pins document_id and optionally version, offset and length. Validate returned offset, version, returned_bytes and EOF. Reconstruct bytes and verify the full SHA-256 and size. history or include_versions adds version metadata.

## Retry rule
Retry transport failures with the same request identity. A per-file validation/conflict error requires inspection, not silent recreation under a new document ID. Storage success and indexing success are separate; verify the committed bytes first, then confirm retrieval of the current head.

## Streaming implementation

The server stages chunked originals on disk and streams staged-path commits. Downloads reuse verified version-pinned disk leases, so repeated ranges do not repeatedly extract the entire original. Default transfer-cache limits are one GiB and one hour, with active leases protected. Browser uploads hash incrementally in a worker with one-MiB reads and send bounded base64 chunks. MCP payloads remain real base64 bytes; the client host decides whether those payloads enter model context.

## Source references
- `app/server.py`
- `client.py`
- `docs/mcp-reference.md`
- `tests/test_mcp.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.

## Folder transfer retries
`upload_folder` requires a logical folder UUID and relative-path items. Reuse that UUID across batches and chunks; each path derives a stable file UUID. Check both stored and folder_assigned. A placement failure can be retried with the same bytes without creating a version, and completed retries do not undo later manual moves. Updates require document_id and expected_version. Empty directories are not stored.

`download_folder` returns bounded ranges of a ZIP snapshot. Reuse folder and transfer_id until EOF and verify whole-ZIP size/hash. The snapshot retains exact selected versions for ten minutes across updates and server restarts. Limits: 1,000 files, 1 GiB of source bytes, four retained archives. The client saves without overwriting or extracting. See `docs/mcp-reference.md` for the complete contract.
