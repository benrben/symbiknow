# Symbiknow / Interface / Desktop pane constraints and responsive behavior

Repository implementation guide. Snapshot: 12 October 2026.

## Pane widths
The sidebar defaults to 250px and accepts 220–340px. The optional inspector defaults to 360px and accepts 300–520px. Pointer separators clamp changes to those bounds; keyboard arrows adjust width in ten-pixel steps. Preferences are library-namespaced and type-validated.

## Narrow desktop tradeoff
Below the supported 1190px threshold, the inspector overlays content. This is a deliberate desktop tradeoff, not a separate mobile redesign. Search and view controls remain important when inspecting a document at a narrow width.

## Content behavior
The Files list remains compact with contained columns and full-name hover/detail. Markdown tables scroll inside their own region. Canvas overview reduces prose to meaningful titles when full-fit zoom would make reading impractical. Folder drill-down and Fit selection restore a narrower reading context.

## Verification sizes
The desktop redesign has captures at 1102×808, 1280×800, 1440×900 and 1920×1080; the later multi-project overview regressions use 1280×720. These are particular captures/checks, not all possible display scaling and browser accessibility settings.

## Diagnostics
When a label clips, distinguish content overflow from viewport scale or overlay. Do not discard full source filenames to make a screenshot fit; preserve their actual metadata.

## Source references
- `frontend/src/App.tsx`
- `frontend/src/styles.css`
- `UI.md`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
