# Symbiknow / Storage / Bulk ZIP exact versions and filename collisions

Repository implementation guide. Snapshot: 12 October 2026.

## Explicit selection
The human bulk-download route accepts 1–100 explicitly selected document/version pairs and caps total content at one GiB. It first validates the complete selection. A missing version stops the action with affected IDs instead of silently producing an incomplete success archive.

## Original bytes
Each entry comes from storage.read_file for the pinned version, including its size/hash verification. The ZIP uses stored entries and a disk-backed temporary archive. It is delivered as a file response and cleaned after delivery; browser handling creates a bounded Blob and revokes its object URL.

## Safe entry names
Uploaded names are reduced to basenames, controls are removed and special empty/dot names receive a safe replacement. Case-insensitive collisions gain numeric suffixes before their extension. These rules protect ZIP entry paths while retaining exact content bytes.

## UI contract
Select all targets loaded rows, not unseen pages. The bulk toolbar communicates the explicit selection. The archive's download is separate from any folder move or content update, so it must not create new versions or change organization.

## Limits
One GiB and one hundred entries are practical guardrails, not a target-hardware memory certification. Large selections should be divided when necessary; an archive failure is not grounds to remove or reupload originals.

## Source references
- `app/ui.py`
- `frontend/src/App.tsx`
- `tests/test_ui_api.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
