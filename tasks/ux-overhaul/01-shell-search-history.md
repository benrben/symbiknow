# Shell, search, dialogs, and document branches

**Owner:** shell worker (GPT-6 Sol). **Owned production files:** `src/AppDialogs.tsx`, `src/VersionPanel.tsx`, `src/CanvasSearch.tsx`, `src/app.css`, `src/canvas-search.css`, `src/editor.css`. Own corresponding component tests. Root owns `src/App.tsx`; request changes there instead of editing it.

## Tasks

1. Repair the 800px desktop shell. Topbar controls must not cover the sidebar or breadcrumb. Canvas, reader, editor, inspector, and assistant must have a deliberate responsive arrangement. Keep critical Save/Cancel, close, and navigation actions reachable.
2. Add modal focus containment and return focus on close. Expose a reusable dirty-close hook or callback for the root's editor state; do not silently close an unsaved draft. Preserve existing delete confirmations.
3. Make search count and ArrowUp/ArrowDown/Enter traverse the same visible filtered results, including other canvases. Preserve the cross-canvas switch confirmation. Show network errors inside search, with Retry, rather than presenting them as zero matches; coordinate needed `App.tsx` props with root.
4. Improve the branch/history view: inspect revisions and branch content before switch, merge, or restore. Include author/date/revision, full before/after diff, affected scope, confirmation, post-action receipt and recovery. Keep direct actions disabled until preview is ready. The live workspace currently has only `main`; use deterministic component tests for a second branch and conflict/error state.
5. Reduce reader/editor content clipping at 800px. Preserve useful 1440px reading width and keyboard focus outlines.
6. **A3/D2:** Search excerpts and history navigation should carry a common evidence target (document, revision, exact passage when available). Provide one **Browse groups** entry for navigation; link to Jev **Organize** for a proposed group change. Do not present browsing controls as if they save a new grouping.

## Acceptance

- Browser at 800px in both themes: no overlapping header controls, no hidden editor Save, readable reader, working sidebar navigation.
- Modal keyboard loop stays inside the active modal and returns focus to its trigger; Escape on a dirty editor offers Save/Discard/Continue editing.
- Search with local and cross-canvas hits reports the full filtered count and keyboard navigation reaches every visible result. Error and no-result states are distinct.
- Restore/branch switch/merge has a read-only preview before execution, and a clear saved result or actionable failure afterward.

## Evidence and dependencies

Screenshots: `/tmp/allteam-800-light.png`, `/tmp/allteam-800-newblock.png`, `/tmp/allteam-800-reader.png`, `/tmp/allteam-1440-search-results.png`, `/tmp/allteam-800-branch-view-deep.png`. Relevant code: `CanvasSearch.tsx:51`, `VersionPanel.tsx:34`, `app.css:262`.
