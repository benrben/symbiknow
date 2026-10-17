# Symbiknow / Interface / Files folders filtering and sorting

Repository implementation guide. Snapshot: 12 October 2026.
## Browsing surfaces
All files, Recent and Unfiled share the same document owner. Files list is the compact browsing surface; thumbnail grid is optional. List markup is a native table with column headers, aria-sort and selected row state. Full original filenames remain available on hover and in Details; display titles remove only the extension.

## Sorting contract
Name, Type and Saved sort on the server before pagination, with document ID as a stable tiebreaker. Recent is latest stored activity, so it visibly marks Saved descending. Choosing a sort leaves Recent and applies that requested order; indicators must never pretend to control an order that the backend ignores.

## Counts and filters
Sidebar counts are global descendant counts. Content-area folder tiles and canvas frames use the folder/group intersection across all pages. Search retrieved-candidate counts are a different measure. When a group filter yields zero files, the empty state offers Clear filters rather than implying the folder is empty and suggesting import.

## Selection and actions
Single click selects a current document. Cmd/Ctrl-click toggles and Shift-click selects a visible range. Select all means loaded files, not unseen pages. Multiple selections expose Move and Download; explicit versions are used for ZIP preparation. Folder context actions allow rename, move and removal without deleting originals.

Tree arrows and disclosure buttons expand independently from selection. Mouse label clicks return focus to the roving treeitem, so subsequent arrow navigation remains consistent.

## Source references
- `frontend/src/App.tsx`
- `frontend/src/components/FileList.tsx`
- `frontend/src/components/Sidebar.tsx`
- `app/ui.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
