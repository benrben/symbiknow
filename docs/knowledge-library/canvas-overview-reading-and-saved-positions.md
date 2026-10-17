# Symbiknow / Interface / Canvas overview reading and saved positions

Repository implementation guide. Snapshot: 13 October 2026.

## Two presentation modes
Folder overview and Document map change presentation, not retrieval or Jev evaluation. Folder frames contain immediate-child documents. At reading scale, document cards show actual bounded text or version-keyed image/PDF thumbnails. Fit, Fit results and Fit selection frame the relevant nodes; the low-zoom folder navigation remains available when card headings are hidden. Search accounts for all returned matches, while related context is separate.

## Current geometry and ownership
Geometry version 3 records separate detail and overview dimensions, positions and position origins. Current detail cards are 174px wide, 196px high in browsing and 224px high for search. Generated positions can migrate to the new geometry; known manual positions are reserved before other cards are placed. Folder frames grow to contain their actual cards.

Unknown legacy search layouts whose overlaps arise from an older compact card size keep their saved coordinates and use compatible compact cards in affected frames. A Saved layout upgrade notice offers Reflow saved layout. Reflow preserves known manual anchors; one-level Undo is persisted across view changes and reloads. Organization changes invalidate stale Undo. This compatibility treatment does not silently rearrange an unknown user layout.

Positions, geometry and viewport are scoped by library and navigation/search scope in localStorage. Content text is not stored there. Overview has its own position/geometry record. Dragging uses card/frame headers; frames move children. Refresh retains measured nodes, and drag completion saves the final position. Arrange and Undo apply to the current scope.

## Evidence access
List, Cards and Canvas share result identities, versions and judgments. Every evidence-badge activation creates a new navigation sequence. It reopens Evidence at the matched version, even after viewing Document, selecting an older version or closing the inspector. The selected evidence region receives keyboard focus. Full evaluated passages remain available when compact cards quote only an excerpt.

## Source references
- `frontend/src/components/LibraryCanvas.tsx`
- `frontend/src/presentation.ts`
- `frontend/src/App.tsx`
- `frontend/src/components/DocumentInspector.tsx`
- `frontend/tests/review10-ui.spec.ts`
- `UI.md`

Geometry and rendering are implementation facts, not a target-capacity or exhaustive accessibility certification.
