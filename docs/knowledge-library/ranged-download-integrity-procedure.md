# Symbiknow / Storage / Ranged download integrity procedure

Repository implementation guide. Snapshot: 12 October 2026.

## Request shape
A download item identifies document_id and optionally version, offset, length and history. Range length must be positive and within the configured chunk limit. Offset must be a nonnegative integer within the file size. The response includes pinned version, offset, returned_bytes, EOF, size, SHA-256 and actual base64 content.

## Verification sequence
1. Pin the first returned version if requesting current.
2. Decode base64 with validation.
3. Require the requested offset and pinned version to match every response.
4. Require decoded size to equal returned_bytes and reject an empty nonterminal range.
5. Append bytes and advance by the actual returned size.
6. At EOF verify accumulated bytes equal declared size and the whole SHA-256.

## File handling
client.download_files writes a unique temporary part and renames only after successful integrity checks. The destination contains document/version identity to avoid filename collisions, and it refuses to overwrite an existing destination. Cleanup removes unfinished temporary files.

## Metadata versus integrity
A one-byte range with history is useful for inspecting head/version metadata without printing a full original. It is not whole-file verification. A historical hash check must download all bytes of that pinned version; filename similarity is irrelevant.

## Source references
- `client.py`
- `app/server.py`
- `app/storage.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
