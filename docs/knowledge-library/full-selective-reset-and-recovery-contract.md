# Symbiknow / Organization / Full selective reset and recovery contract

Repository implementation guide. Snapshot: 12 October 2026.
## Selected fields and scope
Reset organization defaults to the entire library with Folders & groups and Document links selected. A folder scope captures its descendants. Grouping clears folders, subfolders, groups and selected manual placements. Link reset clears selected outgoing links and existing incoming links into the scope. Links-only preserves folder placements; grouping-only preserves valid links.

## Durable boundary
Provider availability is checked before clearing. A preflight failure leaves the existing organization intact. The job records captured document IDs before the clearing → rebuilding → complete phases. Clearing is idempotent, uses set membership and persists checkpoints every thirty-two items; interruption can replay at most thirty-one uncheckpointed items safely.

Rebuilding prepares a shared content-derived taxonomy rather than seeding it from selected obsolete generated names. It uses current stored evidence and embeddings, without creating content versions or re-OCRing only to change organization.

## Failure semantics
Empty/unsupported/unindexable items are skipped with reasons. Failed or skipped items stay Unfiled when grouping was selected, instead of restoring cleared placements. Retry handles failed captured IDs, their latest heads and the same generation. A source superseded during a provider call is retried as current work.

## User contract
Confirmation copy identifies the exact scope and fields that remain. Hiding progress does not cancel the worker. Originals and histories remain intact. Reset serialization is improved, but whole-reset lock duration and complete target-scale throughput remain unverified.

## Source references
- `app/rebuild.py`
- `app/server.py`
- `app/ui.py`
- `tests/test_ui_api.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
