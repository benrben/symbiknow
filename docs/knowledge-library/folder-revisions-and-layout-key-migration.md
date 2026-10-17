# Symbiknow / Organization / Folder revisions and layout key migration

Repository implementation guide. Snapshot: 12 October 2026.

## Server-published changes
The library response includes library identity and organization/reset/manual revisions, with a change record for manual edits. Presentation compares revisions before changing optional local state. A library ID namespaces preferences to avoid applying another library's geometry.

## Rename versus move
A folder rename can preserve geometry by migrating folder position keys, nested scope keys, collapsed paths, folderById entries and expanded tree paths. A document move removes that document's old relative position so its new visual parent can place it safely.

## Partial reset
A full grouping reset removes affected library geometry. A scoped reset removes selected identities even inside an ancestor canvas while preserving unrelated siblings. Links-only does not require clearing folder geometry. Removed scopes can fall back to an existing ancestor or All files.

## Resilience
Preference parsing validates optional structures and bounds the saved working set. Corrupt JSON is not an original-data failure; unsupported entries fall back. No document body belongs in localStorage.

## Regression expectation
Verify a rename across a three-level path, a document move into another frame, subtree reset beside an untouched sibling and switching between Files/Canvas. Compare positions and visible parents rather than accepting any rerender as proof that stale references were removed.

## Source references
- `frontend/src/presentation.ts`
- `app/organization_edits.py`
- `app/ui.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
