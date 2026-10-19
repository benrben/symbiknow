# Symbiknow / Interface / Desktop pane constraints and responsive behavior

Repository implementation guide. Snapshot: 19 October 2026.

## Pane widths
The sidebar defaults to 224px and accepts 200–320px. The optional inspector defaults to 420px and accepts 340–600px. Pointer separators clamp changes to those bounds; keyboard arrows adjust width in ten-pixel steps. Preferences are library-namespaced and type-validated.

## Narrow desktop tradeoff
Split reading reserves space for the file surface; the reader replaces the workspace when that space is unavailable. Expanded reading has a metadata-only folder navigator, hidden below 900px. Below 760px, navigation collapses behind Folders and readable-map clusters use a single column. The active `redesign.css` overrides the older desktop rules; consult all imported styles before inferring a breakpoint. Touch/emulated browser checks are documented in `UI.md`; physical devices and screen readers remain separate validation.

## Content behavior
The Files list remains compact with contained columns and full-name hover/detail. Markdown tables scroll inside their own region. Canvas overview reduces prose to meaningful titles when full-fit zoom would make reading impractical. Folder drill-down and Fit selection restore a narrower reading context.

## Verification sizes
The desktop redesign has captures at 1102×808, 1280×800, 1440×900 and 1920×1080; the later multi-project overview regressions use 1280×720. These are particular captures/checks, not all possible display scaling and browser accessibility settings.

## Diagnostics
When a label clips, distinguish content overflow from viewport scale or overlay. Do not discard full source filenames to make a screenshot fit; preserve their actual metadata.

## Toolbar wrapping — 18 October fix
The toolbar has a 64px minimum height and wraps controls as available workspace width shrinks. Below 760px, search occupies a separate row. This keeps actions reachable at 800px with a sidebar expanded to 320px. The regression covers widths 390, 760, 780, 800, 820, 900 and 1024px at normal and 1.25 CSS zoom, plus 800×600 with the widest sidebar. These are controlled browser checks, not exhaustive browser zoom/display scaling certification. Sources: `frontend/src/redesign.css` and `frontend/tests/manual-ui-regressions.spec.ts`.

## Source references
- `frontend/src/App.tsx`
- `frontend/src/styles.css`
- `UI.md`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
