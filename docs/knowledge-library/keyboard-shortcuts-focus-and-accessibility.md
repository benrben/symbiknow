# Symbiknow / Interface / Keyboard shortcuts focus and accessibility

Repository implementation guide. Snapshot: 19 October 2026.
## Shortcut ownership
Cmd/Ctrl+K focuses search. Enter submits the query; whitespace submission clears an active search. Space on a focused file control opens Quick Look. Space on canvas background supports temporary pan, and Space on a toolbar button retains native activation. Dialog/menu events do not propagate into global library shortcuts.

## Files and tree
Enter/double-click opens the selected file in the reader. Cmd/Ctrl+A selects loaded files when the library owns the shortcut, leaving text-input editing alone. Cmd/Ctrl-click and Shift-click provide toggle/range selection. The native file table exposes headers, direction and selected rows without relying only on color.

Folder tree items use roving focus. ArrowDown/Up traverse visible rows, ArrowRight expands or reaches a child, ArrowLeft collapses or returns to a parent, and Enter selects the scope. Label/disclosure clicks and menu closure return focus to that treeitem. Unicode names remain intact.

## Desktop focus and panes
Dialogs start on safe cancellation where destructive confirmation matters. Escape dismisses the active dialog without also hiding the inspector. Sidebar and inspector separators support arrow-key resizing within their bounds. Under the supported narrow desktop threshold the inspector overlays content.

## Verification boundary
Browser regressions exercise these interactions and DOM semantics. An actual screen-reader session, complete modifier-key/trackpad matrix and instrumented contrast certification remain separate work; keyboard passing is not an accessibility certification.

## Current reading and responsive controls

Cmd/Ctrl+F inside the reader focuses Find in document; Enter/Shift+Enter cycles literal matches. Section jumps focus their rendered heading. Sidebar name filtering and Home/End/Space complement tree arrows. Skip to content, visible focus, polite counts, reduced-motion styles and coarse-pointer controls support navigation. Escape closes map evidence and restores an available control. Automated axe, Chromium/Firefox/WebKit fixtures and touch-device profiles are available through `test:quality` and `test:mobile`; these do not establish actual assistive-technology or physical-device usability.

## Original preview focus return
Closing a current or historical original preview with Escape or the close button returns focus to its visible invoking Open file or Quick Look file control. If that element was removed, the app uses an available reader Open file control, then search. Hidden import/update file inputs have `tabIndex=-1` and remain programmatically usable. The focused 18 October browser regressions cover both close routes, historical versions, Space Quick Look and a removed opener.

## Source references
- `frontend/src/App.tsx`
- `frontend/src/components/Sidebar.tsx`
- `frontend/src/components/FileList.tsx`
- `frontend/src/components/LibraryCanvas.tsx`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
