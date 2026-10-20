# Symbiknow development status

Symbiknow has implemented original-file storage, independent versions, indexing, search, Jev evidence judgments, project folders and links, a human interface, and five MCP tools. The current priority is validating organization quality on realistic prose and larger libraries while preserving the storage and version guarantees.

Symbiknow / Development / Current status

Status date: 19 October 2026 (UI fixes verified 18 October).

## Current implementation snapshot

Source audit: 17 October 2026. This describes the working tree, including the current frontend and answer-part improvements; it is not a claim that those uncommitted changes are a published release.

The application exposes `upload`, `download`, `search`, `upload_folder` and `download_folder`. Browser and HTTP MCP sessions share one owner, worker and data directory. OCFL preserves originals and versions; LanceDB stores replaceable evidence. Storage commit, indexing and organization are separate outcomes. Updates preserve IDs and guard the expected head; current search and links reject obsolete evidence.

The current Jev source uses default model `jev-1.13.0`, prompt `project-membership-6/search-evidence-15` and policy `answer-routing-13`. Up to eight documents receive six supplied windows each, plus one bounded cross-document comparison; four provider calls may run concurrently. Passage support/entity/status concerns the requested part it addresses, while independent all-parts coverage controls completeness. Negative answers, partial support, premise correction and disagreement remain distinct. Project ownership uses sampled owner-bearing passages and canonical identities; filenames and source paths only corroborate substantive context.

The selected live embedding runtime is PyTorch INT8 text weights on tested Apple Silicon MPS, with on-demand bfloat16 vision, serialized ownership and idle unloading. CPU/CUDA use the explicit unquantized fallback. Runtime manifests and measured compatibility receipts guard precision/revision/dimension/preprocessing changes. Conversion uses bounded child processes, one decoded page/frame at a time and Arrow-spooled vectors. Verified disk leases serve originals, ranged downloads and ZIP export. Index retries persist with backoff and permanent-failure pause; preview jobs coalesce within two workers and eight waiting slots.

The current interface provides Overview, List, Cards, readable Map and optional Freeform map. Expanded reading adds folder-file navigation, rendered-heading jumps, bounded literal text search and version-specific reading positions. Review history contains only terminal summaries observed by that browser. Dark/Light/System, matched-version evidence focus, historical originals and bounded PDF-page rendering remain available. Freeform geometry version 3 preserves manual anchors and compatible old layouts until explicit Reflow/Undo. See `UI.md` for current behavior and quality/mobile test commands.

The 17 October memory follow-up records 273 backend tests, 21 related browser flows, Ruff and a production build. On the Apple M5 Pro/48-GB host, matched server/child peak fell from 6.06 to 3.98 GiB; final live idle was 720 MiB and dense scanned-PDF peak was 5.00 GiB. These are dated measurements with different scopes, not a new full-suite run during this documentation audit. See `Optimize-memory-symbiknow.md` and `docs/memory-runtime.md` for evidence and exclusions. Newer UI validation is recorded separately in `UI.md`.

Independent hosted quality, full 100k-original capacity, a sustained 16-GiB whole-system ceiling, CUDA performance, exhaustive power-loss recovery and physical-device/screen-reader usability remain unestablished. Older checks below retain their original dates and limits.

## Historical implementation notes

## Historical implemented behavior

Originals are managed by rocfl/OCFL and checked with SHA-256. Updates keep a document identity and create a new storage version; current search excludes superseded representations. Historical downloads remain exact. The frontend provides Files, Recent, a nested Canvas, query modes, independent Jev evaluation, pinned preview/history, upload notices, selective organization rebuilds and delete confirmations.

Recent review changes added shared folder candidates, heading-derived project/subject paths, hash-verified duplicates, skipped terminal extraction outcomes and layout/filter invalidation. Search now preserves Files/Map selection and verdicts. Document deletion permanently removes all versions; folder deletion moves documents to Unfiled and preserves their files and history.

The ordinary-prose follow-up removes test boilerplate throughout passages, filters generic document-type names, retains named project scope and builds shared subject candidates across prose clusters. New projects receive a new-topic option. Symmetric related/duplicate links display once, while directional relationships retain their source and target evidence. Cards use representative or matching excerpts, scoped counts include all matching pages, and framing includes edge-label bounds.

The fourth review follow-up recognizes unfamiliar single-word project names, prevents unscoped documents from selecting another company's nested folder, and cautiously resolves OCR possessive artifacts against established project roots. Empty Enter submissions and Library navigation clear active searches. Strong same-project/topic link candidates receive reserved capacity within the existing five-neighbor Jev budget, and current document detail records offered link judgments in `organization_review`.

Prose candidate preparation now uses sparse hashed features, at most 128 minibatch centroids per large scope and bounded label samples. Existing vector aggregation streams float32 sums; project-name lookup and prototype comparison avoid scanning the entire taxonomy for each document. Synthetic 100,000-document candidate-preparation runs completed in 21.529 seconds at 682.75 MiB peak RSS for an unscoped corpus, and 25.801 seconds at 453.05 MiB for distinct single-word projects. These measurements exclude the full indexing/rebuild pipeline and do not establish grouping quality or 16 GB capacity.

## Historical verified checks

That earlier recorded suite had 77 passing Python cases, 14 passing Chromium scenarios, Ruff and a successful TypeScript/Vite build. The newly affected reset/candidate checks also passed after representative-profile cleanup. Model decisions and embeddings in these regression suites use explicit local fixtures; these results establish behavior and preservation invariants rather than hosted-model accuracy.

The six ordinary-prose regressions generate Vela Labs / Billing, Vela Labs / Employee access and Oak Garden / Rosemary candidates. Shuffled order, renamed projects, single-document new topics and repeated isolated rebuilds are checked. The live reviewer previously verified 21 QA download hashes and unchanged metadata/history across a 27-document rebuild.

## Review evidence and remaining work

The full feature review and follow-up review are historical observations of earlier builds. The follow-up rated overall product 7/10 and ordinary-prose grouping 5/10 on a small sample; those are reviewer judgments, not general accuracy metrics. Its four prose-grouping/presentation findings were followed by code changes and isolated regressions. Later dated hosted checks are recorded in the current snapshot above; independent held-out quality remains unestablished.

At that earlier stage, PDF embedding and manual folder edits were still outstanding. Current code uses isolated PDFium page images and supports manual folder operations. Live ordinary-prose membership evaluation with distractor projects and wider relationship coverage remain quality priorities.

The target of 100,000 files, broad OCR/relevance accuracy, 16 GB M4 memory, NVIDIA L4 performance, power-loss recovery and exhaustive accessibility/security validation remains unestablished. Small benchmarks ran on an M5 Pro with 48 GB RAM. Use those figures as local observations rather than capacity promises.

## Manual UI report fixes — 18 October 2026
Search Name/Type/Modified sorting now toggles independently of browse order and retains relevance for new queries. UI and full/compact MCP matches carry the current saved-version timestamp. Current/historical original previews restore the invoking control on close, with a visible fallback when it disappears; hidden file inputs no longer enter the tab order. The toolbar wraps at constrained workspace widths, including an 800px window with the maximum sidebar.

The focused check passed 95 backend, five Node and five browser tests plus the production build. Live verification checked seven keyword results' timestamps and preserved the 98-document library's original inventories. See `UI.md`, `VALIDATION.md` and `outputs/ui-bug-fixes-2026-10-18/verification.json` for scope and limits. These fixes do not implement the separate CDM proposal.

## Source references

Current implementation and behavior: `app/`, `frontend/src/`, `README.md` and `UI.md`. Measured checks and limits: `VALIDATION.md` and `docs/performance-evidence.md`. Historical evidence: `full-review.txt` and `rereview.txt` in the supplied review package. The original developer plan is a proposal, not the final implementation inventory.


## Desktop redesign status — 12 October 2026

The desktop shell now uses resizable panes, a compact expandable folder tree,
server-sorted Files rows, a thumbnail layout, multi-selection, ZIP download and
manual folder rename/move. Files and Canvas share search results, judgments and
selection/version. Reset has a durable clearing boundary and provider preflight;
failed/skipped selected files remain Unfiled after folder reset. Manual corrections
persist through indexing/updates using a schema-1 atomic metadata ledger.

Canvas refresh retains measurements to avoid blinking. Saved card coordinates are
checked against their parent; new parents get free slots, frame bounds grow to fit
actual cards, and colliding frames are repaired. Scoped reset preserves unrelated
layouts. Original bytes and versions are unchanged by organization actions.

85 Python tests and 22 browser scenarios passed, plus build/lint. Principal screenshots,
12-document runtime hash/history verification, a separate 10,000-row metadata/UI
measurement and a live provider availability probe are in outputs/desktop-redesign.
These are not hosted-model accuracy or full 100k/16 GB capacity claims. A held-out
human gold set and complete storage/index/provider scale validation remain needed.
UI.md documents operation, API additions, metadata schemas and practical limits.


Deep-review follow-up (12 October): Space ownership, filtered counts/empty recovery,
Recent sort state, GFM tables, tree focus, semantic list markup and history/reset copy
are fixed. Canvas gains compact summary overview; PDF uses a first-page image or an
explicit unavailable state. Jev adds unrelated and clearer partial-support prompts;
candidates offer a general parent and suppress imperative labels. Reset clearing uses
32-item durable checkpoints with idempotent replay. Fresh verification: 93 Python and
31 browser tests passed, plus lint/build. The 12 real originals and histories remain
exact. See outputs/deep-review-fixes/index.html for evidence and unresolved independent
quality, target-capacity, native-runtime and assistive-technology validation.

## Folder MCP tools — 19 October 2026
`upload_folder` accepts bounded batches of relative-path file bytes, preserves subfolders as manual assignments, and reuses the existing original/version/chunk machinery. `download_folder` streams a ZIP snapshot of a folder and descendants, pinned to selected current original versions. Limits are 1,000 files / 1 GiB, four retained exports, ten-minute expiry and bounded transfer ranges. The client adds recursive upload and verified ZIP download commands with HTTP-owner selection. File commits and folder assignment report separate outcomes, allowing identical retries to finish a partial placement.
