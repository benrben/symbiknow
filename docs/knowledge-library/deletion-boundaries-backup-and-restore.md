# Symbiknow / Storage / Deletion boundaries backup and restore

Repository implementation guide. Snapshot: 12 October 2026.
## Removing organization versus originals
Remove folder unfiles documents in the selected folder/subtree while preserving original bytes, history, groups and links. Its manual Unfiled placement is durable. Delete document is different: it permanently purges all versions of that object and removes derived chunks and current incoming links.

Document deletion requires the expected current version. Durable deletion receipts finish an interrupted purge on startup and prevent an old transfer replay from resurrecting that identity. The UI describes all-version deletion and starts on the safe cancel action. Active rebuilds block conflicting organization edits/deletions.

## Backup procedure
Stop the application owner cleanly. Copy the complete configured data directory to an independent destination, including OCFL files, derived index and temporary recovery/transfer/deletion ledgers. Retain the runtime/configuration needed to restore, protecting any credentials separately. A model cache can be managed separately from irreplaceable original documents.

## Restore verification
Start exactly one owner on the restored copy. Download representative current and historical versions and compare their known hashes before trusting retrieval. Check processing status and organization recovery. A damaged or missing derived index can be rebuilt from originals, but reconstruction is not a replacement for a verified original-byte backup.

## Unverified boundaries
A full backup/restore drill and exhaustive power-loss campaign have not been established by the small regression suite. Do not describe permanent purge as undoable unless an independent backup has been verified.

## Source references
- `app/storage.py`
- `app/ui.py`
- `app/search.py`
- `docs/operations.md`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
