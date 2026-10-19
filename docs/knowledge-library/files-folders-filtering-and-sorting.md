# Symbiknow / Interface / Files folders filtering and sorting

Repository implementation guide. Snapshot: 19 October 2026.
## Browsing surfaces
All files, Recent and Unfiled share the same document owner. Files list is the compact browsing surface; thumbnail grid is optional. List markup is a native table with column headers, aria-sort and selected row state. Full original filenames remain available on hover and in Details; display titles omit the extension and may omit a repeated project prefix when the containing folder supplies it. Original filenames remain unchanged.

## Sorting contract
In library browsing, Name, Type and Modified sort on the server before pagination, with document ID as a stable tiebreaker. Recent is latest stored activity, so it visibly marks Modified descending. Choosing a sort leaves Recent and applies that requested order; indicators must never pretend to control an order that the backend ignores.

## Counts and filters
Sidebar counts are global descendant counts. Content-area folder tiles and canvas frames use the folder/group intersection across all pages. Search retrieved-candidate counts are a different measure. When a group filter yields zero files, the empty state offers Clear filters rather than implying the folder is empty and suggesting import.

## Selection and actions
Single click selects a current document. Cmd/Ctrl-click toggles and Shift-click selects a visible range. Select all means loaded files, not unseen pages. Multiple selections expose Move and Download; explicit versions are used for ZIP preparation. Folder context actions allow rename, move and removal without deleting originals.

Tree arrows and disclosure buttons expand independently from selection. Mouse label clicks return focus to the roving treeitem, so subsequent arrow navigation remains consistent.

## Overview and reading

Overview aggregates immediate folder groups across the entire scope and can fetch three metadata-only samples per group. List, Cards and Map are alternate presentations of shared state. Opening a file enters an expanded reader with a folder navigator paged in 60-row batches; its filename search covers the loaded page, while library search covers the folder. The selected file remains available when outside that page. Split view and Back to library preserve the underlying view.

## Search result sorting
Search starts in relevance order and has its own direction state. Clicking Name, Type or Modified starts ascending; clicking the same column reverses it. This reorders loaded matches only, keeps equal-key retrieval order, and does not call search or Jev again. A new submitted query resets relevance order. Modified compares actual timestamp instants; absent or invalid dates stay last in both directions. The shared backend supplies the current saved-version timestamp as `created_at`, including compact MCP results.

Implementation: `frontend/src/searchPresentation.ts`, `app/search.py`, `app/server.py` and `app/search_projection.py`. Regression: `frontend/tests/manual-ui-regressions.spec.ts`.

## Source references
- `frontend/src/App.tsx`
- `frontend/src/components/FileList.tsx`
- `frontend/src/components/Sidebar.tsx`
- `app/ui.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
