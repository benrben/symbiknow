# Symbiknow / Storage / Bulk ZIP exact versions and filename collisions

Repository implementation guide. Snapshot: 19 October 2026.

## Explicit selection
The human bulk-download route accepts 1–100 explicitly selected document/version pairs and caps total content at one GiB. It first validates the complete selection. A missing version stops the action with affected IDs instead of silently producing an incomplete success archive.

## Original bytes
Each entry streams from a verified, version-pinned original-file lease into a disk-backed ZIP using stored entries. Preparation returns a short-lived one-use download URL; the browser follows it directly rather than allocating the whole archive as a Blob. The file response cleans the archive after delivery, and an expiry timer removes abandoned exports. Full-selection validation and exact hash/size checks remain required.

## Safe entry names
Uploaded names are reduced to basenames, controls are removed and special empty/dot names receive a safe replacement. Case-insensitive collisions gain numeric suffixes before their extension. These rules protect ZIP entry paths while retaining exact content bytes.

## UI contract
Select all targets loaded rows, not unseen pages. The bulk toolbar communicates the explicit selection. The archive's download is separate from any folder move or content update, so it must not create new versions or change organization.

## Limits
One GiB and one hundred entries are practical guardrails, not a target-hardware memory certification. Large selections should be divided when necessary; an archive failure is not grounds to remove or reupload originals.

## MCP folder export is a separate selection contract
`download_folder` selects an exact library folder and all descendants, including members not loaded in the browser. It accepts up to 1,000 files / 1 GiB of source bytes and preserves relative subfolders. The first call creates a ten-minute ZIP snapshot of current original versions; later ranges reuse its transfer ID. Up to four snapshots are retained. Clients reconstruct and verify the complete ZIP size and hash, then save it without automatic extraction.

The UI bulk route still accepts 1–100 explicitly selected versions and returns its prepared URL. Its limits and flat basename rules do not replace the folder tool's contract. Both routes stream original bytes and resolve archive-name collisions without changing the stored originals. Folder-export implementation: `app/folder_transfer.py`; tests: `tests/test_folder_transfer.py`.

## Source references
- `app/ui.py`
- `frontend/src/App.tsx`
- `tests/test_ui_api.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
