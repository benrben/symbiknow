# Validation record

Executed 11 October 2026 on an Apple M5 Pro with 48 GB RAM, macOS 26.5.1 / arm64,
Python 3.12.15. `uv.lock` contains the tested versions. Functional checks below do
not establish capacity or broad retrieval quality.

## Functional checks

- **37 tests pass**: 15 actual rocfl storage tests, 12 Docling/LanceDB ingestion and
  search tests, seven official Jev SDK contract tests, and three MCP transfer/recovery
  tests. Ruff passes. A wheel builds and includes the client entry point.
- rocfl 1.7.0 was compiled natively for ARM. Binary and empty payloads, historical
  metadata/bytes, request replay, optimistic conflicts, independent duplicate files,
  concurrent writes, and OCFL validation were checked.
- Interrupted staging, lost responses, and Python-parent SIGKILL during an actual
  child commit recover without duplicate versions. This does **not** establish
  power-loss safety of rocfl's root-inventory update.
- MCP tests use the official 2.3.0 SDK over stdio subprocesses. Exactly three tools
  are listed. Bulk binary files, 768,000-byte chunked uploads, resumed chunks after
  restart, chunk retries, old/current downloads, client hash verification, history
  metadata, and conflicts were checked. This does not establish other agent hosts'
  payload limits or their treatment of model-visible base64.
- A live stdio session passed upload → OCFL → Docling → EmbeddingGemma 2 → hybrid
  search → Jev direct-answer judgment. Jev folder/group metadata persisted, including
  an empty group list. Results are in `mcp-validation.json`; its synthetic temporary
  repository was deleted after the check.
- Real embeddings used the exact Google EmbeddingGemma 2 checkpoint, text and native
  PIL images, normalized 768-dimensional vectors, and MPS/float32. No embedding
  substitute was used. Offline unit tests inject clearly labeled fixture vectors.
- Native visual retrieval without OCR/captions ranked a red image above a blue image
  for "a bright red square" (cosine 0.751 vs 0.680). `visual-validation.json` records
  this small multimodal check; it is reproducible through `scripts/check-runtime.py`.
- Hosted Jev 1.13.0 returned live answerability, organization, and a related-document
  decision with both supplied evidence IDs and endpoint versions. Link confidence
  was 0.54 on the synthetic design/implementation pair. A categorical decision is
  not proof of factual correctness; the app can decline uncertain links.
- A stopped two-version OCFL repository was copied to a separate directory; both
  original and current download bytes/metadata matched after restoration.

## Small real-model benchmark

`scripts/benchmark.py` creates five synthetic files and four labeled questions.
The full report is `benchmark.json`. Models and OCR assets were cached before this
timed run. Image and PDF fixtures share content with Markdown, making exact-file
ranking ambiguous.

| Measurement | Observed |
|---|---:|
| Warm EmbeddingGemma 2 load | 4.01 s |
| Process peak RSS, model + Docling + five files | 4,887 MiB (4.77 GiB) |
| Markdown indexing | 0.513 s |
| HTML indexing | 0.064 s |
| TXT indexing | 0.060 s |
| PNG OCR + native visual indexing | 4.617 s |
| Scanned PDF text + native page-image indexing | 2.261 s |
| Hybrid query medians, three repetitions/question | 121–124 ms |
| Expected file in top three | 4/4 |
| Expected exact file ranked first | 2/4 |

An earlier run peaked at 6.30 GiB and queried in 131–145 ms. RSS is a process
measurement, not a total system/GPU memory ceiling; timing and allocation vary.

The live one-file MCP run measured committed upload response at 0.080 s,
searchable status at 5.401 s including cached model startup, and answer-mode search
at 0.374 s including Jev. These are observations, not latency percentiles.

A separate warm-storage probe used 30 × 64 KiB Markdown files: median save 26.62 ms,
median read 7.38 ms, scan of 30 objects 122.36 ms. A random 10 MiB file saved in
48.64 ms and read in 15.52 ms. These tiny local measurements differ from the model
benchmark's fixture-save timings because of workload and process state.

LanceDB native FTS, explicit-vector hybrid queries, group SQL filters, 1,024-row
cosine IVF-SQ construction, scalar indexes, and compaction were exercised. The
five-file quality/timing benchmark used exact scans, not the ANN configuration.

## Remaining limitations

- **100,000-document capacity is unvalidated.** No real 50-question evaluation set
  or representative large corpus was provided. These fixtures do not establish
  broad semantic accuracy, target-scale latency, or a sustained 16 GB memory ceiling.
- PyTorch/MPS works on the measured M5 Pro host. M4 with 16 GB RAM, MLX, and NVIDIA
  L4 hardware were not tested.
- OCR made heading errors. Tiny/narrow text initially produced no OCR text while
  remaining visually searchable. Extraction quality depends on inputs.
- Images/rendered PDF pages accumulate during per-document conversion. Large scanned
  PDFs and animated/multipage images can use substantially more RAM than this run.
  Page, byte, and conversion-time limits are guards, not validated memory ceilings.
- Download ranges read and verify the whole file each time. Default files are capped
  at 256 MiB. Completed chunk receipts persist in `data/temp`.
- Startup reconciliation scans OCFL objects and invokes the CLI for metadata.
  Normal ingestion uses a bounded queue and retries known failures; queue overflow
  triggers a deferred scan. Startup cost at 100,000 objects is unmeasured.
- Jev is bounded to text evidence and five semantic neighbors plus verified hash peers,
  choosing content-derived subject paths/phrases rather than an unrestricted taxonomy.
  Provider outages preserve ordinary
  search; organization gets another attempt after restart. Direct judgments lacking
  selected supporting passages are downgraded to uncertain.
- A hard-killed rocfl commit or power loss can require validation/restoration because
  upstream inventory publication is not fully atomic. Keep stopped-state backups.
  Original versions are retained until an explicit document deletion is confirmed.

No fastest-server, enterprise durability, or validated target-scale claim is made.

## Human UI validation — 11 October 2026

The implementation now has a React/TypeScript/Vite frontend using React Flow,
Radix primitives, Lucide, React Markdown and DOMPurify. Direct Starlette/Uvicorn
requirements are declared and locked. Human routes and `/mcp` use one SDK HTTP
application lifespan, storage lock and ingestion worker. Legacy stdio remains.

- **55 Python tests passed** in 34.34 s, including the original checks and new real
  OCFL/LanceDB API, thumbnail, reset/recovery and HTTP concurrency tests. Ruff passes.
- **Seven Chromium browser flows passed** in 15.8 s against a temporary fixture server:
  canvas/evidence/history, keyboard/responsive behavior, bulk upload/update/exact
  historical downloads, unsupported files, obsolete responses, hostile HTML,
  search failure retry, Jev unavailability, scoped links-only reset and a real Vite
  proxy upload. The proxy preserves Host rather than using Vite's shorthand
  changeOrigin default, so local dev uploads pass the backend's same-origin check.
  The regression also checks that foreign-origin uploads remain rejected.
  A new-folder map placement check confirms automatic folder bounds do not overlap.
- Two real HTTP MCP clients plus human API requests used exactly one worker; exactly
  three tools were advertised. Disconnecting clients retained the owner lock, and
  server shutdown released it. Same-origin UI mutations and Host checks were tested.
- Selective reset tests cover both checkbox combinations, stable scope IDs, durable
  request continuation, failed-item preservation/retry, superseded uploads during
  provider calls, and repair of interrupted document/chunk filter publication.
  Originals/history are checked throughout. This is process recovery testing,
  not power-loss durability or a global transactional guarantee.
- Production frontend build passes. The canvas is a separate lazy chunk. The main
  bundle is about 506 kB (162 kB gzip) and the canvas about 185 kB (61 kB gzip);
  Vite reports its advisory 500 kB chunk-size warning. No browser latency budget or
  large-corpus performance claim is based on these sizes.
- Actual screenshots at 1440×900 and 1280×800 were visually compared with all three
  supplied references. Additional 960px drawer and 760px Files captures are in
  `screenshots/`. Folder geometry, controls, selection and evidence colors were
  adjusted after inspection. Fictional reference content was not embedded as UI.
- Populated browser fixtures are seven actual stored files with three versions of
  one document, Docling-converted text and LanceDB records. Their embedding vectors
  and official Jev SDK HTTP responses are explicitly mocked for reproducibility.
  The production configuration never selects those test fixtures.
- The existing live MCP check passed again with real EmbeddingGemma 2/MPS and hosted
  Jev 1.13.0: byte integrity, retrieval, direct judgment and organization. Observed
  upload 0.786 s, searchable after 9.090 s, evaluated search 0.539 s. The synthetic
  repository was temporary. These timings are single observations, not percentiles.

The user's actual `data` directory contained zero OCFL documents at completion.
No synthetic screenshot fixtures were inserted into it. The dev UI consequently
shows an empty library until files are uploaded. Both frontend hot reload and
backend Python reload are running on loopback (5173 and 8765 respectively).

See [UI.md](UI.md) for launch/HTTP MCP instructions and remaining limitations.
The map is bounded to 100 visible documents and 100 relations. Derived metadata
counts, durable request records and startup scans still scale with corpus size.
100,000-document capacity, broad retrieval quality, 16 GB memory use and L4
performance remain unvalidated. Browser transfers hash whole files in memory;
inline text previews cap at 2 MiB; PDF preview depends on browser capabilities.

## Review fixes and deletion actions — 11 October 2026

The review follow-up adds shared content-derived taxonomy preparation and stored-vector
candidate ranking, nested subject paths/descendant filters, SHA-256 duplicate peers,
representative passages, skipped terminal extraction outcomes, and reset layout/filter
invalidation. Search now preserves Files/Map selection and its evidence model. Upload
notices follow backend indexing status, and PDF previews always expose Open/Download
fallbacks. The canvas uses nested compact folders and routes inspected edges via
lanes outside document text.

The sidebar folder menu deletes folder organization (including descendants), moving
files to Unfiled. The document menu confirms permanent deletion of all versions,
originals, search chunks and incoming links. Backend checks cover same-origin access,
latest-version conflicts, idempotent deletion retries, interrupted purge recovery,
upload replay protection and deletion during indexing. Background decisions cannot
republish over manual organization or resurrect deleted documents.

Validation: 64 Python cases passed, including the loopback HTTP test run with local
network access; 11 Chromium flows pass, including delete confirmation/cancellation,
historical removal, folder preservation, Files/Map verdict continuity, terminal upload
notices on a paginated library and the PDF fallback. Ruff and the production
TypeScript/Vite build pass. Browser fixtures
use local deterministic decisions and no provider client or HTTP transport. Real
hosted Jev quality, the review's scanned PDF/image corpus and 100k-file behavior have
not been re-evaluated by this follow-up. Functional taxonomy tests cover four intended
subject paths, repeated rebuild membership and byte/history invariants using mocked
membership judgments. Folder create/rename/move and unrestricted generated taxonomy
names remain outside this change.

## Ordinary-prose follow-up — 12 October 2026

Candidate extraction now removes opening, embedded and closing synthetic notices,
suppresses document-type names, extracts named project scope and prepares shared
subject names across prose clusters. Domain-role phrases and distinctive named
subjects carry extra weight; independent document membership remains a bounded Jev
Choice. Existing embeddings rank the cleaned candidate profiles without re-embedding
or changing originals. New-topic choices are available during incremental ingestion,
while another named project's folder is excluded from that document's candidates.

The six neutral-filename notes from the follow-up review are retained as repository
fixtures. Candidate and mocked SDK regressions produce Vela Labs / Billing for the
refund/invoice pair, Vela Labs / Employee access for onboarding/offboarding, and Oak
Garden / Rosemary for the gardening pair. Checks include four shuffled orders,
renamed project names, single-document new-topic choices, repeated full rebuilds and
unchanged original hashes/version metadata. These checks validate candidate plumbing
and these examples; hosted Jev accuracy has not been measured in this follow-up.

Connections deduplicate related/duplicate links by unordered endpoint/version pair
plus relation, preserving a real stored orientation and passage IDs. Both stored
orientations remain valid for evidence inspection; supports/contradicts directions
remain separate. Library card previews use representative evidence, search cards use
matching/supporting evidence, scoped heading counts include all matching pages, and
canvas framing includes routed label extents. Long sidebar names wrap.

Validation: 72 Python cases passed; Ruff and the TypeScript/Vite build pass. All 12
browser scenarios passed (11 in the suite and the new scenario after correcting its
mock evidence provenance). Browser checks include symmetric edge count, label bounds
beside the inspector, scope counts and the matching card excerpt. All tests use
isolated data and local provider fixtures. The live 27-document library was not reset
or modified by these tests. PDF viewing still relies on the browser; the Open/Download
fallback remains. No 100k-document, multilingual or broad semantic-quality benchmark
is established by this change.

### Review 4 follow-up — project isolation, OCR and bounded preparation

Sentence-subject recognition now includes unfamiliar single-word entities. The six
review-4 notes are regression fixtures: Nacre's returns pair shares Commerce, its
onboarding/offboarding pair shares Employee access, and Beacon Studio remains a
separate project. Checks also rename the single-word entity, shuffle the corpus,
include foreign-company references, and repeat full resets with both review corpora.
Documents without a recognized project cannot choose another project's nested path.
These are deterministic candidate/SDK regressions, not unseen hosted-model scores.

OCR can reconcile a dangling lowercase `s` or possessive with an established root;
unknown names and genuinely distinct established roots remain separate. Normal text,
capitalized `Atlas S`, extracted evidence, passage IDs and original bytes are retained.
A full rebuild derives identities from non-OCR evidence before interpreting OCR names.

Prose preparation uses sparse hashed features (8,192 columns). Small scopes use sparse
online similarity; large scopes use at most 128 minibatch centroids. Folder labels
use at most 24 documents per cluster. This fixed topic budget trades fine-grained
candidate separation for predictable preparation cost; Jev still chooses membership
and can choose a new subject or Unfiled. Vector aggregation streams float32 sums
instead of retaining every chunk vector, and compares at most 128 prototypes within
the recognized project. Shared prose assignments are computed once per rebuild.
Project recognition uses a reusable name lookup instead of scanning every project.

`scripts/benchmark-organization.py` measures only `prose_paths` with isolated
synthetic inputs: 100,000 documents, three passages each, about 60 MB of text. On this
machine, the unscoped run took 21.529 seconds with 682.75 MiB process peak RSS; a run
with 100,000 distinct single-word projects took 25.801 seconds with 453.05 MiB peak RSS.
Raw results are in `outputs/organization-benchmark-100k.json` and
`outputs/organization-benchmark-100k-projects.json`. These include Python/import/input
memory, but exclude extraction, LanceDB vectors, embedding-model memory, hosted Jev,
and rebuild persistence. Folder-label quality was not evaluated in this benchmark.
A complete 100k-document rebuild on 16 GB remains unvalidated; loading profiles,
per-document index reads and durable checkpoint rewrites still need scale testing.

Link retrieval reserves up to three strong same-project/topic neighbors ahead of
global semantic candidates within Jev's five-neighbor budget. FTS reads content,
so incorrect prior folder assignments cannot hide these peers. A crowded-vector
regression recovers the Nacre returns pair using real local FTS; a provider rejection
still publishes no link. Current-version document detail exposes `organization_review`
with folder choices and each offered link's judgment, confidence, accepted flag and
passage IDs. SHA-256 duplicate handling and version-bound publication remain intact.

Empty Enter submissions and Library navigation now clear active searches. The clear
button remains available after erasing an active query. Browser checks cover Files
and Map, restored folder scope, view retention and existing stale-response handling.

Validation: 77 Python cases, 14 browser scenarios, Ruff and the TypeScript/Vite build
passed. Browser providers and embeddings are isolated fixtures. Live-library folders
will use the revised candidates on the next rebuild; these tests did not reset the
live library or establish improved hosted Jev link recall.

## Desktop redesign — 12 October 2026

The supplied Files, Folders and Canvas references were inspected before implementation.
The existing React/TypeScript, React Flow, Starlette, OCFL, LanceDB and provider stack
remains in place. The real library was not used for destructive test fixtures or
screenshots. Its twelve documents and twelve versions were verified byte-for-byte,
with metadata/history unchanged, before and after restarting the app on 8765.
The live MCP SDK connection still advertises exactly upload, download and search.
Raw verification: `outputs/desktop-redesign/runtime-verification.json`.

Validation results: **85 Python tests passed in 98.98s**, **22 browser scenarios
passed (Playwright reported 1.1m)**, Ruff passed, and TypeScript/Vite built successfully. The optional
screenshot and synthetic metadata suites are skipped by the ordinary browser command
and run explicitly with their environment flags. The PDF thumbnail regression uses
a real valid PDF and verifies the original download bytes. Backend tests cover
manual subtree edits/collisions, current-version guards, all-or-report ZIP versions,
preflight failure with no mutation, reset clearing interrupted between publications,
retry generation/totals, skipped/failed Unfiled items and incoming links.
A provider failure about a superseded source head is discarded and retried against
the new head; it cannot mark the newer content as failed. Rebuild checkpoints now
fsync both file and containing directory before publication. Browser
checks cover all four target desktop sizes, Unicode names, multi-selection, Quick
Look, tree keyboard navigation, query/view/evidence parity, one rerun per scope,
scoped layout invalidation, Arrange/Undo, refresh during an active drag, changed parent frames, overlap repair and
three polling cycles without hidden measured cards. The subsequent no-chunk startup
filter optimization also passed the interrupted-filter recovery regression.

Canvas cards retain measurements and version-keyed preview caches during refreshes.
Rebuild status objects no longer recreate the polling callback: a bounded request-count
regression checks the four-second interval instead of a response-driven request loop.
Positions include their logical parent context; incompatible parent-relative
coordinates are replaced with free slots. Bounds include actual card positions,
and colliding frames are repaired. Unrelated saved positions survive a subtree reset.
Closing the inspector retains selection and its validated neighborhood. New reset
and manual revision fields distinguish clearing from rename/move migrations.

Manual organization metadata uses an atomic schema-1 ledger and prepared transaction
in `data/temp/manual-organization.json`; startup rolls interrupted edits forward.
`data/temp/library-identity.json` namespaces UI state. These are derived metadata,
with no migration of original OCFL objects or new content versions. Old organization
rows remain readable, with an explicit absence-of-recorded-basis explanation.
Full reset durably captures identities, clears selected active organization/manual
folders and both link directions, then rebuilds. Provider/config preflight occurs
before clearing. A failure differs deliberately from ordinary refresh: it stays
Unfiled for folder resets. Links-only preserves layout/folders, and folders-only
preserves valid links. Retry uses current versions in the original reset generation.

A live TypeSafe preflight returned available in **326.6 ms**. Only availability text
was sent; this is not a live grouping, linking or answerability accuracy assessment.
Raw result: `outputs/desktop-redesign/live-provider-preflight.json`. All automated
quality-like assertions use deterministic provider/candidate fixtures. Existing
human review notes are already regression inputs, so they are not held-out evaluation
data. A separately human-labeled gold corpus was not supplied; no hosted quality
score or benchmark accuracy is claimed. This validation dependency remains open.

The separate desktop metadata run used **10,000 synthetic derived rows plus seven
real fixture documents**, on Apple M5 Pro (18 cores), 48 GB RAM, macOS/local Chrome:
initial 60-row load **104 ms**, folder navigation **91 ms**, keyword search over seven
real indexed fixtures plus large metadata **335 ms**, initial canvas **847 ms**, zoom
action **24 ms**. The working set was 100 documents with **36 visible mounted preview
cards** at measurement time; JS heap **16.98 MiB**, server process peak RSS **675.97
MiB**. These are single local samples, not percentile or best-case claims. Raw JSON:
`outputs/desktop-redesign/metadata-benchmark.json`. No extraction/embedding or hosted
provider decisions were timed. Browser native/GPU memory was not measured.

The synthetic rows have no originals. Initial fixture startup correctly tried to
purge them through original-integrity recovery and timed out at 60 seconds. The
metadata-only benchmark explicitly disables that startup step for synthetic rows;
production recovery is unchanged. This distinction is recorded in
`metadata-benchmark-startup-note.json`. Filter reconciliation now skips zero-chunk
rows, but actual full-library OCFL startup, indexed-corpus retrieval, hosted provider
latency and complete reset on 100,000 originals / 16 GB remain unvalidated. Earlier
100k candidate-preparation runs remain phase-specific evidence only.

Principal screenshots and an evidence index are in `outputs/desktop-redesign/`.
Files/grid/Canvas use twelve real repository document copies in a temporary library.
Additional captures cover search, a controlled failure UI state and long names at
1440×900, 1280×800, 1102×808 and 1920×1080. The original seven-document fixture's
before captures remain in its `before/` subdirectory. Captures are implementation
checks; illustrative reference content was not hardcoded into production.

Remaining practical limits: a browser may still fail to embed a full PDF, while its
first-page thumbnail and Open/Download fallbacks work. Large text inline preview is
bounded to 2 MiB; PDF thumbnail input to 32 MiB/20 seconds; bulk ZIP to 100 explicit
versions/1 GiB. Browser uploads hash one current file buffer, up to 256 MiB, and retain
retry state in the current tab. Vite reports a 500 kB main-chunk advisory; the build
succeeds and measured visible-load evidence is reported separately. No full mobile
layout or unrelated product feature was introduced. Launch and API/migration notes
are in UI.md.


## Deep-review fixes — 12 October 2026

Fresh final verification: **93 Python tests passed in 60.08s**, **31 browser scenarios
passed (reported 1.1m)**, Ruff and TypeScript/Vite passed. The browser suite includes
nine focused review scenarios. The isolated fixture uses actual OCFL/LanceDB and
deterministic embedding/Jev; selected UI branches are controlled API responses.
These results are data/interaction contracts, not hosted-model accuracy.

R01–R04 and R08–R11 have functional regressions; compact Canvas overview, candidate
parent/cohesion changes, unrelated/partial schema behavior and explicit PDF first-page
fallback are covered. Reset clearing checkpoints every 32 items and uses set membership;
interruption can safely replay at most 31 operations. A synthetic 1,000-document job
serialization profile measured 0.1652s / 113,133,000 bytes with per-item checkpoints vs
0.0053s / 3,651,072 bytes with 32 checkpoints. This excludes storage/index/fsync/model
work and does not measure a complete reset.

All 12 real documents / 12 original versions match their hashes and full stored metadata/
histories before and after restarting the app. No real imports/deletes/reset/manual edits
were performed. Reports/screenshots/hashes are in `outputs/deep-review-fixes/`.

The new evaluation harness accepts a separately labeled corpus, reports per-class
precision/recall, pairwise grouping metrics, singleton/Unfiled rates and shuffled-run
stability. No independent gold corpus was supplied. Whole 100k/16 GB operation, full
OCR/retrieval quality, native desktop qualification and screen-reader testing remain
unverified; the implementation does not claim these acceptance checks are complete.


## Review10 follow-up - 13 October 2026

The frozen review10 follow-up passed194 backend tests in182.78 seconds and66 UI tests in1.8 minutes; two existing opt-in design/metadata fixture tests were skipped. Ruff and production build passed. See `outputs/review10-followup/index.html` and `verification.json` for exact commands, raw receipts and limits. These are dated results, not a claim that later source changes were covered by the same run.

Fresh live policy10 MCP responses accepted the correct README v2 t0 counterevidence for the generic source-control and Git-hosting paraphrases. Neutral Git questions retained support without a correction. Compact traversal kept all62 IDs/versions and useful evidence. Hosted pinned/self-authored quality corpora total122 document judgments with valid local IDs and exact supplied windows; they are not independent population accuracy evidence. Uncertain labels and possible references remain visible.

The saved-layout fixture that predicts16 old-renderer overlap pairs has zero actual overlaps in compatible rendering, Reflow and reloaded Undo. Manual anchors and original coordinates are preserved. Twenty-four production evidence-navigation states passed, with source subject and negation visibly inside Cards/Canvas. Testing used ephemeral browser storage, preserving the user's real saved map. All627 original files and79 metadata records remained unchanged during that repair's verification. Subsequent user-authorized imports legitimately add new files and content versions.

## Manual UI report verification — 18 October 2026

Four reported issues were repaired: search header direction, missing saved-version dates in results, preview focus restoration and toolbar clipping at intermediate widths. Verification passed 95 backend tests (`test_search.py`, `test_ui_api.py`, `test_search_entrypoints.py`, `test_mcp_five_fixes.py`), five search-presentation Node tests, five `manual-ui-regressions.spec.ts` browser tests, and the TypeScript/Vite production build. These 105 focused tests are not a new full-suite result or an accuracy measurement.

The browser fixture supplies 70 documents and covers both sort directions, current/historical preview close routes, Quick Look, removed-opener fallback, and toolbar widths 390–1024px at normal and 1.25 CSS zoom. CSS zoom is not exhaustive browser zoom certification. Live keyword verification checked seven results against browse timestamps. All 98 live documents' original inventories remained unchanged during verification; no provider calls were made for these checks. Evidence: `outputs/ui-bug-fixes-2026-10-18/verification.json` and `toolbar-800.png`. Documentation sync on 19 October is a separate operation and legitimately creates new document versions.

## Folder MCP tools — 19 October 2026

Added `upload_folder` and `download_folder`, bringing the advertised API to five tools. The focused run passed **92 tests in 156.49 seconds**, including 15 folder-transfer cases and existing MCP/search regressions. Ruff passed. Real MCP HTTP and stdio checks cover nested relative paths, exact binary bytes, chunk resume across restart, stable retry identities, guarded updates, partial placement recovery, later manual moves, ZIP snapshots across updates/restart, collision handling, invalid paths, export limits/expiry and failed-export cleanup. Client ZIP saving verifies the complete hash and refuses overwrite.

Tests used isolated temporary libraries; they do not establish full-library scale, hosted-model quality or a production load benchmark. Commands and output: `outputs/folder-tools-2026-10-19/tests.log`; source hashes and test scope: `outputs/folder-tools-2026-10-19/verification.json`. Live activation and original-inventory preservation are recorded separately in `activation.json`.
