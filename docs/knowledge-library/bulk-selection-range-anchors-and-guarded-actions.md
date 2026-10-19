# Symbiknow / Interface / Bulk selection range anchors and guarded actions

Repository implementation guide. Snapshot: 17 October 2026.

## Selection owner
App.tsx stores selected document IDs and a range anchor. A normal click selects one document and updates an already-open reader. Double-click or Enter opens reading; Space opens Quick Look on a focused file control. Cmd/Ctrl-click toggles an ID; Shift-click uses the current visible list between anchor and target. Multi-selection hides a single-document inspector and exposes a bulk summary.

## Loaded scope
Cmd/Ctrl+A selects loaded visible files, respecting editable controls. Pagination does not silently select unseen files. Sorting/scoping/search responses reconcile the selection to the new visible IDs rather than applying actions to vanished rows.

## Move
The organization dialog submits explicit document IDs with expected current versions. The backend validates all selected heads before publication and rejects a stale selection. Destination can be an existing path, a new valid nested path or Unfiled. Original bytes and history do not change.

## Download
Bulk ZIP pins the selected versions and validates the whole selection. Missing files produce an actionable failure rather than a partial success archive. Single-row actions still expose Download, Update, Versions and Delete.

## Test interpretation
A Cmd-click pair and visible Shift range are interaction tests. A complete modifier-key/platform/assistive-technology matrix remains additional coverage; color alone must not signal selection.

## Source references
- `frontend/src/App.tsx`
- `frontend/src/components/FileList.tsx`
- `frontend/src/components/OrganizationDialog.tsx`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
