# Symbiknow / Interface / Shared search state and presentation invalidation

Repository implementation guide. Snapshot: 19 October 2026.
## One state owner
App.tsx keeps the folder/group/Recent scope, query draft and submitted question, retrieval mode, Jev preference, selected documents, pinned version and active Files/Canvas view together. Switching views reuses returned search results and judgments rather than issuing another evaluation solely for a view toggle.

## Requests and races
Abort controllers and generation checks prevent obsolete responses from replacing a later query. A scope/mode/Jev change reruns a submitted query after the new scope is available. Clearing or whitespace Enter restores browsing. Selection is reconciled with the new visible set, rather than blindly retaining an unrelated document.

## Saved preferences
presentation.ts namespaces optional preferences by library. It validates stored types and tolerates malformed JSON. A user's early action is protected from late preference hydration. Saved values include pane widths, view/layout, mode/Jev and canvas/tree presentation; original document bodies do not go into localStorage.

## Metadata revisions
Manual renames migrate folder/layout keys and expanded paths. Moves invalidate affected document geometry. Partial grouping reset removes positions only for captured identities and affected scopes, preserving unrelated siblings. Links-only reset leaves folder geometry intact. Removed scopes fall back appropriately.

## Refresh stability
Polling uses a stable load dependency structure and ordinary intervals rather than a response-triggered rebuild loop. Measured canvas nodes, content cache and active drag state survive refresh. Regression checks bound polling requests and compare positions across switching, refresh, rename and reset.

## Result order and saved timestamps
Search column and direction are one state pair, separate from browse sorting. Name, Type and Modified can reverse independently; a new submitted query resets relevance order. `sortSearchMatches` in `frontend/src/searchPresentation.ts` reorders only loaded matches without another retrieval/evaluation. Dates compare actual instants, with missing/invalid values last. The backend supplies the current saved-version `created_at` in search results, so dates do not depend on whether the match was also present on a loaded browse page.

## Source references
- `frontend/src/App.tsx`
- `frontend/src/presentation.ts`
- `frontend/tests/ui.spec.ts`
- `frontend/tests/zz-desktop.spec.ts`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
