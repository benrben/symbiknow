# Symbiknow human interface

The UI uses the existing OCFL originals, LanceDB documents/chunks, ingestion worker,
EmbeddingGemma 2 and TypeSafe Jev. React + TypeScript + Vite, React Flow, Radix,
Lucide, React Markdown and DOMPurify provide the interface. No second data owner,
MCP tools, database, model runtime, daemon or queue was added.

## Launch

Requires Node.js 22.12+ and the existing Python/rocfl setup in README.md. From the
project root, install the frontend once:

```sh
npm --prefix frontend ci
```

Run the UI with frontend hot reload and backend Python reload:

```sh
sh scripts/dev.sh
```

Open http://127.0.0.1:5173. The backend is http://127.0.0.1:8765. The development
proxy preserves Host/Origin and uses the same mutation protection as a built UI.
Stop an existing stdio owner before starting. Ctrl+C stops both development servers.
On this workspace, a verified Node 22.23.3 runtime is available in `.tools/node/bin`;
the scripts use it when present. On other machines, install Node normally.

One-command build and launch, serving everything from one port:

```sh
sh scripts/web.sh
```

Open http://127.0.0.1:8765. An optional `--port 8767` selects a different port.
To build without launching: `npm --prefix frontend run build`.

## MCP connection

While the UI server is running, all agents connect to the existing HTTP endpoint:

```json
{"mcpServers":{"symbiknow":{"url":"http://127.0.0.1:8765/mcp"}}}
```

Use the HTTP/Streamable HTTP server connection setting of your MCP client. Do not
launch a stdio process against the same data directory. The endpoint still exposes
`upload`, `download`, `search`, `upload_folder`, and `download_folder`. Multiple sessions and browser requests
share the SDK application's lifespan, owner lock and worker. Disconnecting a client
does not stop ingestion. `uv run python -m app.server` remains the alternative stdio
launch when the web server is stopped.

## Desktop behavior

Overview, List, Cards and Map share navigation, submitted search, ranking, Jev judgments,
selection and version. View changes reuse results without another evaluation.
All files, Recent and Unfiled are separate scopes. Recent uses the latest stored
version's real timestamp; the table labels this field **Modified**. Name, type and
saved-date sorting in library browsing happen on the server before paging. Recent visibly selects Modified
descending; choosing a table sort leaves Recent and applies that sort. The native
table exposes column headers, sort direction and row selection. Sidebar counts cover
the whole library; content tiles and canvas counts use the folder/group intersection
across all pages. A zero-match group offers Clear filters instead of suggesting import.

Compact is the default: 13px/18px interface text, 30px file rows, 28px tree rows,
and a toolbar with a 64px minimum height that grows when controls wrap. Comfortable uses 14px text and 38px file rows; reader text stays
15px/23px. One Overview | List | Cards | Map control and density persist per library. The
sidebar starts at 224px (200–320px), and the reader at 420px (340–600px). Drag the
separators or use Left/Right. Split reading keeps approximately 520px for files;
at narrower widths the reader replaces the workspace. Expand reader has an explicit
return-to-split action. Tree disclosure is separate from folder selection, counts
include descendants, and full paths remain accessible in tooltips and the filter
picker. Cards show short real excerpts or bounded image/PDF thumbnails.
PDFium, already supplied by Docling, renders the first PDF page in a
separate process with a 20-second timeout and 32 MiB input cap. Preview failures
retain Open/Download fallbacks. PDF cards show the first-page thumbnail. The reader and Quick Look render the requested
page through the same isolated PDFium process, with Previous/Next controls and a page
count. Reader images are bounded to 1,400 pixels per edge, a 20-second timeout and
a 32 MiB source cap, cached by document/version/page. Original PDF Open/Download
actions remain available. No embedded PDF frame or additional renderer was added. Markdown readers and cards share remark-gfm tables, task lists and code fences;
tables scroll within their container. Raw HTML and remote resources stay disabled.

Click selects and updates an already-open reader; double-click/Enter opens the split reader; Space opens Quick Look only
on a focused file control/card. Canvas background and toolbar Space remain available
for pan and button activation. Dialog/menu shortcuts do not propagate to the library.
Cmd/Ctrl-click toggles selection and Shift-click selects a visible range. Cmd/Ctrl+A
selects the loaded files, never the whole unseen scope. Multiple selections show a
bulk summary with Move and ZIP Download. The ZIP includes every explicitly selected
version, handles filename collisions, and stops with per-item errors if a requested
version is missing. ZIP downloads and manual multi-file moves accept up to 100 items;
ZIP content is capped at 1 GiB. Context menus retain update, versions, download and
permanent document deletion. Updating explicitly pins the existing ID and expected
current version; filenames never establish identity.

The common reader has Document, Versions, Connections and Details tabs. Details shows original
metadata, processing, organization origin and recorded assignment evidence. Connections loads stored
relationships directly, without requiring a visit to Details. Expand reader and Split view have explicit labels. Related
documents and Why linked use stored relationship types, passage IDs, headings/pages
and exact endpoint versions. Old versions preview/download their actual bytes and
carry no current judgments or connections. Historical Details explicitly says organization
was not recorded rather than implying Unfiled/Pending. Closing the inspector retains the canvas
selection and neighborhood; it does not discard positions or the submitted query.
HTML originals remain attachments and previews remain DOMPurify-sanitized opaque
sandboxed frames with restrictive CSP. Inline text preview stays bounded to 2 MiB.

Search defaults to Hybrid and preserves previous Jev preferences. Semantic and
Keyword remain available; the MCP answer alias is unchanged. Enter submits, while
mode/toggle/scope changes rerun a submitted question once. Whitespace and Clear return
to browsing in the current scope. Cmd/Ctrl+K focuses search. Stale requests cannot
replace a later query. Filters contains folder search, topic groups, and expandable Search options for retrieval mode and answerability.
The answerability control explains that selected text goes to TypeSafe;
Jev's answerability switch does not control background organization. Result counts say Showing N matches (the response is capped at 40); checked, supporting,
possible-conflict and not-checked counts disclose partial evaluation. Direct/partial/related/unrelated/uncertain/not-checked states stay distinct. Visual-only
matches cannot get answer badges. Provider failure keeps ordinary retrieval usable.

Overview opens a readable folder overview, with aggregate counts across the entire scope,
including folders absent from the first loaded page. Visible groups can fetch up to three metadata-only
sample rows; each row opens the reader, while Open folder switches to the file list. The overview
uses two columns when space permits and collapses to one beside the inspector. Overview and Map are separate navigation choices. The compact overview fits all four current
root groups in a 1280×720 desktop viewport. Map opens readable clusters; Freeform map retains
the existing graph and saved layouts, and Readable map returns to the new map. Browsing card excerpts
remove introductory metadata and prefer actual source prose. Cards also have an explicit Preview action.

The optional Freeform map uses neutral compact folder frames with 174px document cards (196px in browsing,
224px for search evidence), arranged in
2–3 columns. Browsing previews are bounded to six per folder (one per folder in
large overviews), with actual shown/total counts and Open folder. Every returned
search match remains represented or accounted for by a revealable collapsed folder;
related context never counts as a search match. Above 75% zoom, cards show title,
metadata and excerpt; at 45–75% they show title/metadata/status; below 45% they use
markers and folder summaries. Zoom/pan does not retrieve or reevaluate documents.
Search layouts and browsing layouts have separate bounded storage, including
viewport, collapsed folders and manual positions. Compact overview positions are
independent of detailed positions, so legacy large-card placement cannot stretch
overview frames. Fit includes all represented folder frames; below 45% a readable
group navigation panel sits beside the graph, with actual names/counts and folder
opening actions. An unchanged status poll preserves
positions and zoom. Selected links is the default display; All returned links and
Hidden are presentation preferences. Only real returned relationships are drawn,
and symmetric relationships have no directional arrow. Selecting an edge shows a
small filename/relation strip; View evidence opens both actual versions and citations.
Card headers are drag handles;
content is selectable and read-only. Cards stay inside their frame, and frames move
their children. Positions are checked against the parent frame when organization
changes, frame bounds include actual card positions, and overlapping saved frames
are repaired. Existing placements are retained for ordinary imports; new cards use
free slots. Background polling preserves measured nodes and cached previews to avoid
blinking. Status polling uses a stable callback at four-second intervals. Arrange/Undo affect only the current scope's positions and never call Jev.
Scroll pans, Space+drag pans, and Cmd/Ctrl+wheel zooms. Fit, Fit selection and Fit
results are distinct. Initial pages have 60 documents; the canvas working set is
capped at 100, with explicit Showing N of M and folder/paging alternatives.

Presentation preferences use library-namespaced, bounded localStorage records:
widths, view/layout, density, mode/Jev, tree expansion, positions and viewport;
up to twenty search layout records per library. Reset revisions clear affected canvas
and tree state. Links-only resets preserve folder placement.
Document bodies never go into localStorage. Corrupt values fall back safely.

## Manual organization and reset

Rename and Move to are real local UI APIs, not public MCP tools. Renames update all
descendants. Moves reject self/descendant destinations and ambiguous collisions.
Names preserve Unicode and normalize path separators. Moving files sets their primary
folder; semantic groups remain separate. Removing a folder unfiles its descendants,
with originals, versions and links preserved. Document deletion remains permanent
and current-version guarded. Conflicting organization edits are disabled during reset.

Manual overrides use `data/temp/manual-organization.json`, **schema 1**, with per-ID
folder assignments, a revision and a recoverable prepared metadata transaction.
An atomic, fsynced file update precedes success. Startup rolls a prepared transaction
forward. Routine indexing/content updates preserve manual folders; reset explicitly
clears selected overrides. Existing libraries require no OCFL migration or new service.
A small schema-1 `data/temp/library-identity.json` namespaces presentation preferences.
Old organization rows without assignment evidence remain readable; Details explains
that no assignment passage IDs were recorded rather than fabricating a rationale.

Reset organization defaults to Entire library and both options. Jev provider/config
preflight happens before any clearing. Confirmation text names the exact scope, selected
fields and preserved fields, including incoming-link clearing for link resets. The durable job captures IDs before its
**clearing → rebuilding → complete** phases. Selected folders/groups/manual changes
are removed even for unsupported, empty or failed files. Links-only preserves folders
and geometry; folders-only preserves valid links. Link resets address incoming and
outgoing references. Failed/skipped files remain Unfiled after folder reset and retain
originals; retry operates on failed captured IDs, current heads and the same generation.
Fresh content supplies replacement taxonomy, excluding selected stale names. Closing
progress does not cancel the worker. Scope disappearance falls back to an ancestor or
All files. Presentation invalidation is scoped, including affected identities within
an ancestor canvas, and preserves unrelated layouts. Full-library clearing/checkpoints
use set membership and batches of 32. An interruption can safely replay at most 31
uncheckpointed clear operations. Full storage/index/provider scale still needs validation. Ordinary provider failure keeps a
previous valid organization and exposes its failed processing state.

Added local endpoints: `rename-folder`, `move-folder`, `move-documents`, and
`bulk-download`. Existing library/detail endpoints gain library identity, scoped reset
revision, manual revision/change, aggregate processing state and assignment origin/
evidence. Public MCP also includes upload_folder and download_folder alongside upload, download and search. Original bytes,
IDs, filenames and content versions are unchanged by organization operations.

## Verification

```sh
uv run --locked pytest -q
uv run --locked ruff check app client.py tests scripts
npm --prefix frontend run build
npm --prefix frontend test
```

This workspace can use `.venv/bin/python -m pytest -q` and `.venv/bin/ruff` directly.
For bundled Node: `PATH="$PWD/.tools/node/bin:$PATH" npm --prefix frontend test`.
Browser tests use an isolated temporary OCFL/index repository on 8766 and test Vite
on 5174. They use real original bytes, conversions, metadata and local indexes, with
explicit deterministic embedding/Jev substitutes. SDK transport is tested separately.
They do not reset, populate or delete the real user's library.

Capture the twelve-document design fixture:

```sh
PATH="$PWD/.tools/node/bin:$PATH" SYMBIKNOW_DESIGN_FIXTURE=1 npm --prefix frontend test -- design-capture.spec.ts
```

Measure the separate synthetic metadata fixture:

```sh
PATH="$PWD/.tools/node/bin:$PATH" SYMBIKNOW_METADATA_ROWS=10000 npm --prefix frontend test -- metadata-benchmark.spec.ts
```

Screenshots and raw verification results are in `outputs/desktop-redesign/`.
The principal captures use copies of twelve real repository documents, not the live
library. Before/after baseline captures of the original seven-document fixture are
also retained. Target desktop sizes are 1440×900, 1280×800, 1102×808 and 1920×1080.

## Validation limits

The focused presentation checks run with `node --test frontend/tests/unit/browse-presentation.test.mjs`
and cover aggregate scopes, Unfiled, null/zero counters, and prose selection.

The deterministic tests establish data/UI contracts, not hosted Jev accuracy. The
live provider preflight establishes availability only. No held-out human-labeled
quality corpus was supplied; multilingual/cross-project regressions are candidate
checks, and existing review fixtures are already known regression data. A human gold
set is still needed to measure independent folder quality, link precision and
answerability errors. Full 100,000-document operation on 16 GB remains unverified;
synthetic metadata and earlier bounded candidate benchmarks do not establish it.

The earlier desktop transfer checks used whole-file browser hashing and ZIP Blobs.
The 17 October implementation hashes one-MiB slices in a worker, uploads bounded
base64 chunks, and follows a short-lived prepared ZIP URL. Upload request receipts
remain scoped to the current tab. Original PDF Open/Download stays available when
inline page rendering fails. Later narrow-screen and emulated-device checks are
recorded below; editing, collaboration and cloud hosting remain outside this UI.

## Deep-review follow-up (12 October 2026)

`outputs/deep-review-fixes/index.html` maps R01–R13 to changes and honest validation
limits. `scripts/evaluate-jev.py` accepts a separately labeled JSON corpus and either
hosted decisions (`--live`) or saved predictions (`--predictions`). It reports per-class
precision/recall and confusion counts, pairwise grouping precision/recall, singleton/
Unfiled rates and shuffled-run co-membership stability. Annotation provenance and split
are required; developer-authored regressions are not an independent held-out benchmark.
The harness never reads or reorganizes the app library. See `--help` for the input schema.

## Readable library and appearance (13 October 2026)

The Appearance button beside Import offers Dark, Light and System. Dark is the
default for new preferences. The global `symbiknow.appearance` preference survives
reloads and synchronizes across tabs; System follows changes to the OS theme.
Menus, dialogs, the sidebar, canvas frames/edges and sanitized HTML readers share
the resolved theme. Original images and rendered PDF pages keep their own colors.

Cards put the document title first, followed by a bounded preview and one 11px
format/folder/version row. PNG/JPG and other supported images use real thumbnails;
PDF blocks show page one. Word/HTML blocks show extracted content, text and Markdown
show passages, and CSV uses literal table cells (first 9 rows including a header, up
to 6 columns and 160 characters per cell, at most 64 KiB parsed from files ≤2 MiB).
Word previews are extracted excerpts, not a recreation of Office page formatting.
Historical CSV previews use the requested original; historical extracted Word content
is unavailable when the current-only index cannot supply it. Unsupported/failed
previews retain original downloads. No synthetic document images are used in the app.

Folder overview / Document map changes presentation only. Overview hides document
previews for a compact map; detail shows previews inside blocks. Search identities,
ranking, evidence actions, folders and actual links remain shared with List and Cards.
Geometry version 3 reflows generated positions for the larger preview area. Manual
placements take priority when placing other cards, and old compact search layouts
retain their compatibility treatment until Reflow. No stored file or Jev operation
is involved in changing the view, theme, layout or density.

Optional media test library: `SYMBIKNOW_MEDIA_FIXTURE=1 .venv/bin/python tests/ui_fixture.py`.
This creates PNG/JPG/PDF/CSV/Word samples in the fixture's temporary repository, not
the real library. It uses deterministic test embeddings/Jev and runs on port 8766.

## Jev review actions without resetting

Library actions now offers **Organize unfiled files** and **Review connections**.
The Unfiled view also has a **Organize files** button. Grouping targets the captured
set of unfiled documents, excludes manual placements (including intentional
Unfiled placements), and uses the existing project/folder vocabulary. Uncertain
ownership stays Unfiled. Links-only review supports the entire library or a folder
and its descendants; candidate links can reach outside that scope.

Both modes reuse the durable organization job and worker. They never clear folders,
manual placements, incoming links, or canvas layout. Accepted current-version links
are merged by target/version/relation, with existing evidence retained. Source and
target versions are checked before publication; provider failures keep the previous
organization, and Retry failed items retains the original mode and scope. Files
without text evidence are skipped and listed. The links-only SDK path asks only
relationship/evidence questions, without project, folder or group decisions. This
is a bounded candidate review, not an exhaustive all-pairs graph analysis.

The Jev activity panel shows a determinate file-completion bar, current filename,
activity, completed/remaining counts, skipped files and failures. The percentage
measures finished files, not provider-call progress; no ETA is fabricated. The panel
can be hidden while work continues, reopened via **Show review status**. Successful completion becomes a compact Review complete
indicator with expandable details. Failures and files needing a folder remain prominent. Unknown
counters are omitted rather than rendered as null or guessed as zero. Motion respects reduced-motion preferences.

Reset organization remains a separate explicitly destructive metadata rebuild.
The MCP tool list is upload, download, search, upload_folder and download_folder.

Completion now separates files grouped, still unfiled, skipped, failed, and links
added. An unresolved ownership decision has a visible reason in the activity panel
and document inspector. A completed review is not a claim that every file was placed.
Project ownership includes research and dependency comparisons belonging to the
project's knowledge base; it does not require that the project be the main topic.
Filenames alone and embedded commands cannot establish ownership. Acceptance
thresholds remain unchanged. Links-only reset also preserves existing ownership
metadata and asks only relationship questions. A visual-only document without OCR
is marked "Jev needs extracted text", not as a provider failure.

Image and PDF chunking includes OCR text nested inside diagram pictures, page
headers and footers, and standalone diagram headings. These remain extracted
source text with Docling page/bounding-box provenance; visual embeddings alone
still cannot establish textual answer support. Existing affected files need a
derived reindex before Jev can use the newly retained text; no new file version
is required. `tests/test_ingest.py` covers headers and nested diagram text for both
images and PDFs.
Batch reviews retain repeated project headers and substantive policy text as
ownership evidence. Shared lines can affect topic ranking, but repetition alone
does not make source text disposable boilerplate.

Live regression scripts: `scripts/check-jev-actions.py` and
`scripts/check-jev-edge-cases.py`. They require a separate synthetic library served
on port 8767 and real EmbeddingGemma 2 / TypeSafe configuration. Never point their
action tests at the user's primary library. Mocked pytest results and these authored
live regressions are distinct from independent held-out model-accuracy evaluation.

Tests: `pytest -q tests/test_jev_review.py tests/test_ui_api.py tests/test_jev.py`.
For local UI verification, `SYMBIKNOW_REVIEW_FIXTURE=1 SYMBIKNOW_MEDIA_FIXTURE=1
.venv/bin/python tests/ui_fixture.py` adds one unfiled document and slows the mocked
provider enough to inspect real worker progress. It sends no data to TypeSafe.

## Focused reader and readable map

Opening a document enters a reading workspace with a compact, searchable file navigator
for its folder (or the loaded search results). Folder navigation fetches metadata only,
in 60-file pages with explicit loading and coverage; the selected document is retained
when it is outside the current page. Split view and Back to library preserve the
underlying view. UI titles omit a repeated project prefix, while source document text
is unchanged. Markdown previews expose On this page navigation derived from rendered
headings, with keyboard focus moving to the selected section. Reading positions are restored by exact document and version identity. Phone navigation collapses behind Folders.

The readable Map uses normally sized document buttons, responsive folder clusters,
per-cluster Show more/Show fewer, and explicit loaded/total coverage. All aggregate
folders remain represented even when their files are not yet loaded. Selecting a file
loads its existing neighborhood; selecting a returned relationship emphasizes its
endpoints and opens a side panel with versions and the recorded relation. Source
passages are fetched on request from the existing link-evidence endpoint. Only links
whose exact endpoint versions are represented may be drawn. Supports/contradicts links
are directional; related links are not. Neighbor failures expose Retry. The map labels
its limited coverage and never implies that the selected neighborhood is the full graph.
Zoom stays within 85–140% for readability, with native scrolling and Fit columns.

Verification for this iteration: TypeScript and production build, focused Node tests
for aggregate scopes, null counters, excerpt selection, map endpoint versions, selected
endpoint inclusion, contextual groups, and UI-only title shortening; live browser
checks of the overview, file navigation, heading jumps, source passages, load-more, and
390px/820px responsive previews. The historical Playwright specifications are maintained against the current navigation
and the explicit Split view control.

## Finding, reading, and scale polish (17 October 2026)

- Reader text search supports literal case-insensitive matching, next/previous matches and Enter/Shift+Enter. Cmd/Ctrl+F within the reader focuses its search. Markdown and text previews highlight matches without modifying the source or the React-rendered DOM. Results are bounded at 500 highlights. HTML/PDF retain their existing preview behavior.
- Reading position is stored for up to 200 exact document/version identities, scoped to the local library. A resumed document provides Back to top. No document text is stored by this feature.
- The folder sidebar has name filtering, Home/End/Space support, and bounded indentation for deep paths. Reader file navigation uses 60-row pages instead of a terminal 100-file cutoff. Its search explicitly covers the current page.
- The readable map filters loaded filenames/folders, explains partial coverage, filters the selected file's returned relationships by type, and shows connection lists in batches of 20. Exact endpoint-version validation remains required for drawn lines. Selecting a file or connection focuses the evidence heading; Escape closes evidence and restores an available control.
- Review history retains the latest 30 terminal job summaries observed by this browser. Times are explicitly observation times, not fabricated completion timestamps. The backend exposes neither historical jobs nor file-by-file change events, so this browser history is not an audit log.
- Search results expose the active retrieval method directly. A selected result explains its supplied evidence; backend answer explanations are displayed only when evaluation is enabled and available. Empty results retain recovery actions.
- Skip-to-content, consistent visible focus, polite result counts, reduced-motion overrides, coarse-pointer targets, and collapsed navigation below 760px support keyboard and narrow-screen use.
- Markdown rendering and the reader are loaded on demand. Production initial JavaScript fell from about 627 KB to 420 KB before compression; deferred Markdown is about 159 KB and reader about 57 KB. This is a bundle comparison, not a measured user-perceived speed guarantee.

Validation: production TypeScript/Vite build; 18 Node regression tests; browser checks of real document search, next match, section jumps, position restoration across file switches, map search, relationship filtering, dialog focus return, keyword no-results recovery, dark/light views, and 390px/640px responsive frames. Main text/secondary/accent tokens exceed 4.5:1 on tested surface/raised/selection colors in both themes. This is not a full accessibility certification.

Reproducible development fixtures: `/tests/fixtures/ui-scale.html` renders 10,000 synthetic metadata rows across 100 groups, with 250 connections for the first file; only 300 file nodes render initially. `/tests/fixtures/ui-responsive.html` embeds the app at 390px and 640px. Both are development-only; neither is included in the production entrypoint. Cross-browser checks are available through `npm run test:quality`. Physical-device,
human screen-reader, and independent usability validation remain separate from automated checks.


## Reproducible UI quality checks

From `frontend/`, run `npm run build` before `npm test`. The legacy browser suite
uses a disposable OCFL library on port 8766 and a Vite proxy on 5174; its mutations
never target the primary library. Search and provider decisions are deterministic
fixtures, not model-accuracy evidence.

`npm run test:quality` runs the focused reader, readable map, keyboard navigation,
responsive layouts and axe WCAG 2.0/2.1/2.2 A/AA checks in Chromium, Firefox and
WebKit. Install the latter engines with `npx playwright install firefox webkit`
or set `PLAYWRIGHT_BROWSERS_PATH` to an existing browser installation. It routes
all API requests to synthetic data and uses port 5176. Light and dark audits cover
overview, filters (including advanced options and active scopes), review history,
list, cards, selected map and reader. Clipped scrolling targets are brought into
view and checked again with the same target-size rule; no rule is disabled.

Two fixture-dependent legacy tests run separately, with no early-stop limit:

```sh
SYMBIKNOW_UI_PORT=8767 SYMBIKNOW_DESIGN_FIXTURE=1 SYMBIKNOW_UI_RESULTS=design-test-results npm test -- design-capture.spec.ts
SYMBIKNOW_UI_PORT=8768 SYMBIKNOW_METADATA_ROWS=10000 SYMBIKNOW_UI_RESULTS=benchmark-test-results npm test -- metadata-benchmark.spec.ts
```

The metadata benchmark measures synthetic derived rows plus seven fixture
documents. It does not measure extraction, full-library original-file operations,
real model accuracy or hosted-provider latency. Automated axe and emulated
viewports are useful regression checks, not accessibility certification or
physical-device usability results.

## Mobile accessibility regression checks

`npm --prefix frontend run test:mobile` uses isolated synthetic data with touch-enabled
iPhone SE, iPhone 13, iPad and Pixel 7 browser profiles. It covers current navigation
state, folder-menu Escape/focus recovery, 44px navigation controls, 16px input text,
reader focus restoration, portrait/landscape reflow, reduced viewport height, filter
focus containment, empty-search recovery and automated WCAG checks.

These checks emulate devices; reduced height does not reproduce an actual OS keyboard.
They do not replace physical iOS/Android devices, VoiceOver/TalkBack speech and rotor
testing, or usability testing with people who use assistive technology.

## Manual UI report fixes — 18 October 2026

Search lists start in relevance order. Name, Type and Modified each toggle ascending/descending independently of the browse order; choosing another column starts ascending. Sorting reorders loaded matches without another retrieval or answer check. A new submitted query resets relevance order. Modified uses the matched current version's saved timestamp, supplied by the shared backend in both full and compact MCP results. Invalid or missing dates sort last in either direction.

Closing an original preview with Escape or its close button restores the visible invoking control: Open file for reader previews, or the file control for Space Quick Look. This also applies to historical versions. If that control disappeared, focus falls back to an available reader Open file control or search. Hidden import/update file inputs are excluded from keyboard tab order.

The toolbar wraps as the workspace narrows, including an 800px window with a 320px sidebar. Below 760px, search uses its own row. The targeted layout checks covered widths 390, 760, 780, 800, 820, 900 and 1024px at normal and 1.25 CSS zoom, plus an 800×600 viewport with the widest sidebar. CSS zoom checks are not certification of every browser zoom or display scaling setting.

Focused verification passed 95 backend tests, five search-presentation unit tests, five browser regressions and the TypeScript/Vite production build. The browser tests use controlled 70-document fixtures. Live keyword verification found seven matching documents with timestamps equal to their browse metadata; the 98-document library's original inventories were unchanged by verification. No provider calls were made for those checks. See `outputs/ui-bug-fixes-2026-10-18/verification.json`, `frontend/tests/manual-ui-regressions.spec.ts` and the dated validation record. This was a focused regression run, not a complete project test run.

## MCP folder transfers — 19 October 2026

Agents can import file trees with `upload_folder` and export a library folder with `download_folder`. Imported relative subfolders use durable manual assignments and appear in the same sidebar and scope filters as UI moves. Export includes descendants and original versions in a bounded ZIP snapshot. This adds MCP tools and client commands; the existing UI file import and selected-file ZIP controls retain their behavior. See [MCP folder contracts](docs/mcp-reference.md#folder-transfers).
