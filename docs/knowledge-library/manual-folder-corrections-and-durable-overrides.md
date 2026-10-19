# Symbiknow / Organization / Manual folder corrections and durable overrides

Repository implementation guide. Snapshot: 19 October 2026.
## Human corrections
The interface supports renaming and moving a folder/subtree, moving selected documents into an existing or new nested path, and removing a folder while retaining its documents. These edit organization, not original content or version history.

## Durable ledger
Schema-one manual-organization.json under data/temp stores document-ID folder assignments and a published revision/change. Atomic writes flush the file and directory. A prepared edit is persisted before publishing index metadata; startup recovery rolls it forward. Ordinary failed publication can restore the earlier ledger and rows.

Routine reindexing/content updates reapply the stored override. A full grouping reset explicitly removes overrides for its captured scope. Removing a folder records manual Unfiled assignments so a background decision does not simply recreate the removed placement.

## Validation
Paths normalize accepted separators, reject empty components/control characters and . or .. components, and preserve Unicode. Depth and component-length limits apply. A folder cannot be moved into itself or a descendant, and colliding destination names are rejected. Every selected document's expected version is validated before a multi-file move.

## UI publication
Revision/change metadata lets the frontend migrate renamed layout keys and expanded tree paths or invalidate moved/reset document geometry. Sidebar and content filters refresh from the server's real metadata. A manual correction is not a model judgment and should be labeled as such in Why here.

## Bounded read views

Repeated status/detail requests reuse one latest snapshot for a data directory rather than repeatedly parsing and deep-copying the full ledger. Narrow accessors return protected values; callers needing edits receive copies. This reduces metadata allocation without changing schema 1, atomic publication, reset semantics or original versions.

## MCP folder imports
`upload_folder` uses the same manual-assignment ledger to place each stored document in the destination plus its relative parent folders. Indexing and later content updates preserve this placement. A folder import reports storage and placement separately: retry identical bytes with the same folder UUID if storage succeeded but placement failed. Once placement completed, retry receipts prevent a later manual move or reset from being undone. Importing files does not remove other members of that folder. Standalone folder moves and renames remain UI operations.

Implementation: `app/folder_transfer.py`; transfer and restart regressions: `tests/test_folder_transfer.py`.

## Source references
- `app/organization_edits.py`
- `app/search.py`
- `app/ui.py`
- `tests/test_ui_api.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
