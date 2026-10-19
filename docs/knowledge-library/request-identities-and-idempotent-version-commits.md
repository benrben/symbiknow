# Symbiknow / Storage / Request identities and idempotent version commits

Repository implementation guide. Snapshot: 17 October 2026.

## Identity rules
The public upload path normalizes request_id as a UUID. For a new object, storage derives a deterministic UUID from a supplied request identity. A lost initial response can therefore be retried without guessing which document was created.

## Replay before conflict
For an existing object, storage uses a durable hashed request lookup under `temp/receipts/DOCUMENT_ID/`, with a complete-through head marker. OCFL remains authoritative: missing or interrupted lookup state is repaired from version metadata. Ordinary known requests avoid a complete historical scan; new requests check receipt-file coverage to detect partial loss. Identical bytes and metadata return the original committed version rather than creating another. Reusing that ID with a different filename, source, MIME, document identity, size or hash is a conflict. Distinct updates use distinct request IDs and guard the current head with expected_version.

## Deletion interaction
A durable deletion receipt prevents replay against a permanently purged identity. Creating a deliberately new document requires a fresh request identity. A filename is not an identity and duplicate filenames can legitimately describe different documents.

## Import bookkeeping
Keep the request ID, document ID, source path, source hash, resulting version and verification result in a local receipt. Persist request IDs before sending transfers so a resumed script replays the same operation. An unchanged source refresh should skip the update rather than create a redundant version. This describes the repository's storage contract, not a generic deduplication rule for every matching file.

## Source references
- `app/storage.py`
- `app/server.py`
- `tests/test_storage.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
