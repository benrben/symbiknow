# Symbiknow development status

Symbiknow has implemented original-file storage, independent versions, indexing, search, Jev evidence judgments, project folders and links, a human interface, and three MCP tools. The current priority is validating organization quality on realistic prose and larger libraries while preserving the storage and version guarantees.

Symbiknow / Development / Current status

Status date: 13 October 2026.

## Current implementation snapshot

The current evaluator uses Jev 1.13.0, prompt `project-first-3/search-evidence-10` and policy `answer-routing-10`. Passage primitives see their own text; document choice and disagreement see the supplied bounded set. Identity is separate from the assumed mechanism. Neutral negative answers, partial support and false-premise corrections remain distinct; uncertainty and possible references stay explicit. Retrieval reserves one of the existing six context slots for a document's first numbered text passage while preserving three ranked passages.

Review10 follow-up recorded 194 backend tests and 66 UI tests passing, with two optional fixture tests skipped. Five fresh live MCP cases, exact downloads and all62-result traversal passed. Hosted quality checks used pinned/self-authored cases; they do not establish independent population accuracy. Receipts are in `outputs/review10-followup/`.

The current interface supports Dark, Light and System appearance; default new preferences are Dark. Cards have real extracted or image/PDF previews. PDF reader/Quick Look has bounded Previous/Next page rendering and exact original downloads. Canvas geometry version3 expands previews and reserves manual placements. Unknown old compact search layouts retain compatible geometry until explicit Reflow, with persisted Undo. Repeated evidence activation restores matched-version Evidence and focus. Read `UI.md` for current operation; earlier sections below are dated implementation history.

## Historical implementation notes

## Implemented behavior

Originals are managed by rocfl/OCFL and checked with SHA-256. Updates keep a document identity and create a new storage version; current search excludes superseded representations. Historical downloads remain exact. The frontend provides Files, Recent, a nested Canvas, query modes, independent Jev evaluation, pinned preview/history, upload notices, selective organization rebuilds and delete confirmations.

Recent review changes added shared folder candidates, heading-derived project/subject paths, hash-verified duplicates, skipped terminal extraction outcomes and layout/filter invalidation. Search now preserves Files/Map selection and verdicts. Document deletion permanently removes all versions; folder deletion moves documents to Unfiled and preserves their files and history.

The ordinary-prose follow-up removes test boilerplate throughout passages, filters generic document-type names, retains named project scope and builds shared subject candidates across prose clusters. New projects receive a new-topic option. Symmetric related/duplicate links display once, while directional relationships retain their source and target evidence. Cards use representative or matching excerpts, scoped counts include all matching pages, and framing includes edge-label bounds.

The fourth review follow-up recognizes unfamiliar single-word project names, prevents unscoped documents from selecting another company's nested folder, and cautiously resolves OCR possessive artifacts against established project roots. Empty Enter submissions and Library navigation clear active searches. Strong same-project/topic link candidates receive reserved capacity within the existing five-neighbor Jev budget, and current document detail records offered link judgments in `organization_review`.

Prose candidate preparation now uses sparse hashed features, at most 128 minibatch centroids per large scope and bounded label samples. Existing vector aggregation streams float32 sums; project-name lookup and prototype comparison avoid scanning the entire taxonomy for each document. Synthetic 100,000-document candidate-preparation runs completed in 21.529 seconds at 682.75 MiB peak RSS for an unscoped corpus, and 25.801 seconds at 453.05 MiB for distinct single-word projects. These measurements exclude the full indexing/rebuild pipeline and do not establish grouping quality or 16 GB capacity.

## Verified checks

The latest recorded suite has 77 passing Python cases, 14 passing Chromium scenarios, Ruff and a successful TypeScript/Vite build. The newly affected reset/candidate checks also passed after representative-profile cleanup. Model decisions and embeddings in these regression suites use explicit local fixtures; these results establish behavior and preservation invariants rather than hosted-model accuracy.

The six ordinary-prose regressions generate Vela Labs / Billing, Vela Labs / Employee access and Oak Garden / Rosemary candidates. Shuffled order, renamed projects, single-document new topics and repeated isolated rebuilds are checked. The live reviewer previously verified 21 QA download hashes and unchanged metadata/history across a 27-document rebuild.

## Review evidence and remaining work

The full feature review and follow-up review are historical observations of earlier builds. The follow-up rated overall product 7/10 and ordinary-prose grouping 5/10 on a small sample; those are reviewer judgments, not general accuracy metrics. Its four prose-grouping/presentation findings were followed by code changes and isolated regressions. Later dated hosted checks are recorded in the current snapshot above; independent held-out quality remains unestablished.

At that earlier stage, PDF embedding and manual folder edits were still outstanding. Current code uses isolated PDFium page images and supports manual folder operations. Live ordinary-prose membership evaluation with distractor projects and wider relationship coverage remain quality priorities.

The target of 100,000 files, broad OCR/relevance accuracy, 16 GB M4 memory, NVIDIA L4 performance, power-loss recovery and exhaustive accessibility/security validation remains unestablished. Small benchmarks ran on an M5 Pro with 48 GB RAM. Use those figures as local observations rather than capacity promises.

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
