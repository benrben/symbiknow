# Symbiknow / Storage / Original bytes and version history

Repository implementation guide. Snapshot: 17 October 2026.
## Identity and format
A document ID identifies one OCFL object. Human filenames are metadata rather than upload-controlled paths inside the repository. Storage uses OCFL 1.1 and the hashed n-tuple layout through the checked rocfl 1.7.0 executable. Committed versions contain original and metadata.json.

## What a version means
A content update commits another independent OCFL version for the same document ID. An explicit expected_version prevents a stale client from overwriting a newer head. Rebuilding folders, moving files, reindexing or repairing filters changes derived organization; these operations must not create a content version.

Version metadata includes the original filename, MIME type, source, request identity, size, creation timestamp and SHA-256. read_file pins the metadata version even when the caller originally asked for current, then checks returned size and hash. Historical downloads can explicitly request v1 while current is v2 or later.

## Reading safely
Use MCP download to retrieve actual base64 bytes. Pin the first returned version across all ranges and compare the full reconstructed hash. The version-history response is metadata; it is not a substitute for verifying historical bytes.

## Limits
The repository's tests and recent twelve-document checks demonstrate exact byte/history preservation for their inputs. They do not establish exhaustive storage durability under power cuts. Keep an independently verified backup before relying on recovery from device failure or permanent deletion.

## Leased original transfers

`storage.verified_file` materializes a version-pinned original to a bounded disk cache, verifies its size/hash and leases it during use. MCP ranges, HTTP original delivery and ZIP export share this path. Active leases prevent cache pruning; existing responses can finish their pinned bytes after deletion, then the final lease removes the cached file. New reads still validate OCFL and fail for deleted originals. The compatibility `read_file` helper still returns whole bytes; do not infer that every internal call is streaming.

## Source references
- `app/storage.py`
- `app/server.py`
- `tests/test_storage.py`
- `tests/test_mcp.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
