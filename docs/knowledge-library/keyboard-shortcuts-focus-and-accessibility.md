# Symbiknow / Interface / Keyboard shortcuts focus and accessibility

Repository implementation guide. Snapshot: 12 October 2026.
## Shortcut ownership
Cmd/Ctrl+K focuses search. Enter submits the query; whitespace submission clears an active search. Space on a focused file control opens Quick Look. Space on canvas background supports temporary pan, and Space on a toolbar button retains native activation. Dialog/menu events do not propagate into global library shortcuts.

## Files and tree
Enter/double-click opens the selected original preview. Cmd/Ctrl+A selects loaded files when the library owns the shortcut, leaving text-input editing alone. Cmd/Ctrl-click and Shift-click provide toggle/range selection. The native file table exposes headers, direction and selected rows without relying only on color.

Folder tree items use roving focus. ArrowDown/Up traverse visible rows, ArrowRight expands or reaches a child, ArrowLeft collapses or returns to a parent, and Enter selects the scope. Label/disclosure clicks and menu closure return focus to that treeitem. Unicode names remain intact.

## Desktop focus and panes
Dialogs start on safe cancellation where destructive confirmation matters. Escape dismisses the active dialog without also hiding the inspector. Sidebar and inspector separators support arrow-key resizing within their bounds. Under the supported narrow desktop threshold the inspector overlays content.

## Verification boundary
Browser regressions exercise these interactions and DOM semantics. An actual screen-reader session, complete modifier-key/trackpad matrix and instrumented contrast certification remain separate work; keyboard passing is not an accessibility certification.

## Source references
- `frontend/src/App.tsx`
- `frontend/src/components/Sidebar.tsx`
- `frontend/src/components/FileList.tsx`
- `frontend/src/components/LibraryCanvas.tsx`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
