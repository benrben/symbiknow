# Symbiknow project documentation

The app library contains documentation sourced from this repository: current implementation guides, the repository copy of the original build checklist and generated PNG/PDF media. The two bundled OCFL standards remain as repository references and are excluded from the current live refresh at the user's request. Current source and validation records describe implemented behavior; the build checklist is historical planning material.

Symbiknow / Development / Documentation catalog

## Current guides

| Library filename | Source and purpose |
| --- | --- |
| Symbiknow README.md | Repository `README.md`: setup, models, MCP tools, transfer examples and guarantees. |
| Symbiknow UI guide.md | Repository `UI.md`: launch modes, Files/Canvas, search, histories, organization and deletion. |
| Symbiknow validation record.md | Repository `VALIDATION.md`: regression and real-runtime evidence, dates and limits. |
| Symbiknow architecture.md | `docs/architecture.md`: current modules, data stores, worker and publication rules. |
| Symbiknow MCP reference.md | `docs/mcp-reference.md`: HTTP connection, upload/download/search schemas and byte-transfer behavior. |
| Symbiknow operations.md | `docs/operations.md`: running, indexing outcomes, rebuilds, deletion and backup/recovery. |
| Symbiknow current development status.md | `docs/current-status.md`: implemented review fixes and remaining validation priorities. |
| Symbiknow performance evidence.md | `docs/performance-evidence.md`: complete benchmark, MCP and native-image JSON records in searchable form. |
| Symbiknow project documentation.md | This documentation catalog. |

## Expanded implementation guides

On 12 October 2026, 29 focused repository guides were authored under `docs/knowledge-library/` from the current implementation. Their shared headings use `Symbiknow / subject / guide` so organization can reuse meaningful subjects. These describe code and observed validation, rather than external specifications or invented future features.

| Subject | Library filename | Repository source |
| --- | --- | --- |
| Architecture | Symbiknow Data ownership and system flow.md | `docs/knowledge-library/data-ownership-and-system-flow.md` |
| Architecture | Symbiknow Repository module map.md | `docs/knowledge-library/repository-module-map.md` |
| Architecture | Symbiknow Ingestion lifecycle and processing states.md | `docs/knowledge-library/ingestion-lifecycle-and-processing-states.md` |
| Architecture | Symbiknow Concurrency and safe publication.md | `docs/knowledge-library/concurrency-and-safe-publication.md` |
| Storage | Symbiknow Original bytes and version history.md | `docs/knowledge-library/original-bytes-and-version-history.md` |
| Storage | Symbiknow MCP transfer batching chunks and retries.md | `docs/knowledge-library/mcp-transfer-batching-chunks-and-retries.md` |
| Storage | Symbiknow Safe document updates and conflict handling.md | `docs/knowledge-library/safe-document-updates-and-conflict-handling.md` |
| Storage | Symbiknow Deletion boundaries backup and restore.md | `docs/knowledge-library/deletion-boundaries-backup-and-restore.md` |
| Search | Symbiknow Retrieval modes ranking and scopes.md | `docs/knowledge-library/retrieval-modes-ranking-and-scopes.md` |
| Search | Symbiknow Evidence IDs provenance and current head rules.md | `docs/knowledge-library/evidence-ids-provenance-and-current-head-rules.md` |
| Search | Symbiknow Embedding runtime and vector compatibility.md | `docs/knowledge-library/embedding-runtime-and-vector-compatibility.md` |
| Search | Symbiknow Text PDF image and OCR ingestion.md | `docs/knowledge-library/text-pdf-image-and-ocr-ingestion.md` |
| Organization | Symbiknow Project subject taxonomy and candidate cohesion.md | `docs/knowledge-library/project-subject-taxonomy-and-candidate-cohesion.md` |
| Organization | Symbiknow Manual folder corrections and durable overrides.md | `docs/knowledge-library/manual-folder-corrections-and-durable-overrides.md` |
| Organization | Symbiknow Full selective reset and recovery contract.md | `docs/knowledge-library/full-selective-reset-and-recovery-contract.md` |
| Organization | Symbiknow Relationships deduplication and link evidence.md | `docs/knowledge-library/relationships-deduplication-and-link-evidence.md` |
| Organization | Symbiknow Jev answerability labels and safeguards.md | `docs/knowledge-library/jev-answerability-labels-and-safeguards.md` |
| Organization | Symbiknow Bounded taxonomy preparation and scale limits.md | `docs/knowledge-library/bounded-taxonomy-preparation-and-scale-limits.md` |
| Interface | Symbiknow Files folders filtering and sorting.md | `docs/knowledge-library/files-folders-filtering-and-sorting.md` |
| Interface | Symbiknow Canvas overview reading and saved positions.md | `docs/knowledge-library/canvas-overview-reading-and-saved-positions.md` |
| Interface | Symbiknow Preview history GFM and PDF behavior.md | `docs/knowledge-library/preview-history-gfm-and-pdf-behavior.md` |
| Interface | Symbiknow Keyboard shortcuts focus and accessibility.md | `docs/knowledge-library/keyboard-shortcuts-focus-and-accessibility.md` |
| Interface | Symbiknow Shared search state and presentation invalidation.md | `docs/knowledge-library/shared-search-state-and-presentation-invalidation.md` |
| Operations | Symbiknow Launch modes and single owner checklist.md | `docs/knowledge-library/launch-modes-and-single-owner-checklist.md` |
| Operations | Symbiknow Configuration dependency and secret boundaries.md | `docs/knowledge-library/configuration-dependency-and-secret-boundaries.md` |
| Operations | Symbiknow Startup reconciliation and recovery runbook.md | `docs/knowledge-library/startup-reconciliation-and-recovery-runbook.md` |
| Operations | Symbiknow Local security and content rendering boundaries.md | `docs/knowledge-library/local-security-and-content-rendering-boundaries.md` |
| Operations | Symbiknow Regression test map and current evidence.md | `docs/knowledge-library/regression-test-map-and-current-evidence.md` |
| Operations | Symbiknow Capacity and independent quality evaluation plan.md | `docs/knowledge-library/capacity-and-independent-quality-evaluation-plan.md` |

## Additional technical guides

A second expansion adds 24 deeper implementation/procedure guides, bringing the authored guide set to 53. Together with the original 12 repository/reference documents, the intended library contains 65 documents. Current transfers and verification are recorded in `docs/library-expansion-2-receipt.json`.

| Subject | Library filename | Repository source |
| --- | --- | --- |
| Architecture | Symbiknow LanceDB document and chunk schema.md | `docs/knowledge-library/lancedb-document-and-chunk-schema.md` |
| Architecture | Symbiknow Atomic metadata transactions failure matrix.md | `docs/knowledge-library/atomic-metadata-transactions-failure-matrix.md` |
| Architecture | Symbiknow Current head checks at retrieval boundaries.md | `docs/knowledge-library/current-head-checks-at-retrieval-boundaries.md` |
| Architecture | Symbiknow Runtime dependency and extension contracts.md | `docs/knowledge-library/runtime-dependency-and-extension-contracts.md` |
| Storage | Symbiknow Resumable upload state machine.md | `docs/knowledge-library/resumable-upload-state-machine.md` |
| Storage | Symbiknow Ranged download integrity procedure.md | `docs/knowledge-library/ranged-download-integrity-procedure.md` |
| Storage | Symbiknow Request identities and idempotent version commits.md | `docs/knowledge-library/request-identities-and-idempotent-version-commits.md` |
| Storage | Symbiknow Bulk ZIP exact versions and filename collisions.md | `docs/knowledge-library/bulk-zip-exact-versions-and-filename-collisions.md` |
| Search | Symbiknow Keyword search diagnostics for imported guides.md | `docs/knowledge-library/keyword-search-diagnostics-for-imported-guides.md` |
| Search | Symbiknow Visual similarity versus textual answer support.md | `docs/knowledge-library/visual-similarity-versus-textual-answer-support.md` |
| Search | Symbiknow Neighbor discovery budgets and link coverage.md | `docs/knowledge-library/neighbor-discovery-budgets-and-link-coverage.md` |
| Search | Symbiknow Index maintenance vector dimensions and migration.md | `docs/knowledge-library/index-maintenance-vector-dimensions-and-migration.md` |
| Organization | Symbiknow OCR aliases and project identity policy.md | `docs/knowledge-library/ocr-aliases-and-project-identity-policy.md` |
| Organization | Symbiknow Folder revisions and layout key migration.md | `docs/knowledge-library/folder-revisions-and-layout-key-migration.md` |
| Organization | Symbiknow Rebuild checkpoints and interruption replay trace.md | `docs/knowledge-library/rebuild-checkpoints-and-interruption-replay-trace.md` |
| Organization | Symbiknow Relationship acceptance and stale evidence checklist.md | `docs/knowledge-library/relationship-acceptance-and-stale-evidence-checklist.md` |
| Interface | Symbiknow Bulk selection range anchors and guarded actions.md | `docs/knowledge-library/bulk-selection-range-anchors-and-guarded-actions.md` |
| Interface | Symbiknow Lazy content cards cache and text budgets.md | `docs/knowledge-library/lazy-content-cards-cache-and-text-budgets.md` |
| Interface | Symbiknow PDF first page rendering pipeline and failure states.md | `docs/knowledge-library/pdf-first-page-rendering-pipeline-and-failure-states.md` |
| Interface | Symbiknow Desktop pane constraints and responsive behavior.md | `docs/knowledge-library/desktop-pane-constraints-and-responsive-behavior.md` |
| Operations | Symbiknow Quality corpus JSON schema and offline scoring.md | `docs/knowledge-library/quality-corpus-json-schema-and-offline-scoring.md` |
| Operations | Symbiknow Performance measurement exclusions and reproducibility.md | `docs/knowledge-library/performance-measurement-exclusions-and-reproducibility.md` |
| Operations | Symbiknow Isolated live runtime checks without library pollution.md | `docs/knowledge-library/isolated-live-runtime-checks-without-library-pollution.md` |
| Operations | Symbiknow Repository document refresh receipts and provenance.md | `docs/knowledge-library/repository-document-refresh-receipts-and-provenance.md` |

## Visual handbook and current media - 13 October 2026

The current documentation refresh adds a six-page visual handbook PDF, three implementation diagrams, two screenshots of the real UI and a searchable media index. It also refreshes changed repository guides in place, preserving document IDs and older versions. That 13 October set contained 64 Markdown documents and six media originals; operational receipts and fictional fixtures remain excluded.

| Library filename | Repository source |
| --- | --- |
| Symbiknow Visual handbook and media index.md | `docs/knowledge-library/visual-handbook-and-media-index.md` |
| Symbiknow visual handbook.pdf | `output/pdf/Symbiknow visual handbook.pdf` |
| Symbiknow architecture diagram.png | `docs/media/Symbiknow architecture diagram.png` |
| Symbiknow MCP file flow diagram.png | `docs/media/Symbiknow MCP file flow diagram.png` |
| Symbiknow search evidence diagram.png | `docs/media/Symbiknow search evidence diagram.png` |
| Symbiknow library cards screenshot.png | `docs/media/Symbiknow library cards screenshot.png` |
| Symbiknow library canvas screenshot.png | `docs/media/Symbiknow library canvas screenshot.png` |

The handbook is supplemental; the full Markdown set retains detailed implementation and reference material. Source and exact transfer verification are recorded in `docs/library-media-refresh-receipt.json`. The screenshots are dated pre-import views captured in a fresh browser context, preserving the user's actual saved layout and preferences.

## Historical planning in the repository

| Library filename | Source and status |
| --- | --- |
| Symbiknow original build checklist.md | Repository `docs/original-build-plan.md`: reproduction of the original build plan; historical proposed phases and assignments. |

External developer-plan HTML, proposed-tree exports and review reports are excluded
from the app library. Fictional QA fixtures under `tests/fixtures/` are test inputs,
rather than project documentation, and are also excluded.

## Repository storage standards (excluded from current live refresh)

| Repository reference | Source |
| --- | --- |
| OCFL 1.1 specification.md | The versioned OCFL specification shipped in `data/files/ocfl_1.1.md`, including its attribution and license. |
| OCFL hashed n tuple storage layout.md | Extension 0004 reference shipped in `data/files/0004-hashed-n-tuple-storage-layout.md`. |

The two reference documents were deleted from the live library during this refresh. The user explicitly requested that they remain excluded; their local source files are preserved.

## Import and future updates

Files are transferred through Symbiknow's MCP `upload` tool on the existing HTTP owner. Original source paths, hashes, request IDs, document IDs and versions are recorded locally in `docs/library-replacement-receipt.json` for the repository-only replacement. The later expansion/refresh uses `docs/library-expansion-receipt.json`, recording created/updated/unchanged documents and MCP verification without deleting existing history. `docs/library-import-receipt.json` describes the earlier, superseded mixed-library import. These receipts are operational bookkeeping rather than imported content documents.

Preserve a document ID for a later source-file update and provide the latest expected version. Reuse the same request ID only for an identical retry. Verify all full download hashes before marking an import complete. Indexing and provider organization may finish after the file's storage commit.

Current documentation snapshots should take precedence over historical planning statements and older review scores when interpreting the implemented application. Consult `docs/current-status.md` and the dated validation sections for remaining gaps.

## Current source sync — 17 October 2026

The selected documentation set now contains **68 Markdown sources and six existing media originals (74 documents)**. All 54 focused guides under `docs/knowledge-library/` are included. The new runtime/memory entries complement the earlier catalog:

| Library filename | Repository source |
| --- | --- |
| Symbiknow memory runtime controls.md | `docs/memory-runtime.md`: selected PyTorch INT8 runtime, compatibility guards, fallback and resource controls. |
| Symbiknow memory optimization record.md | `Optimize-memory-symbiknow.md`: implementation checklist, dated verification and remaining limits. |
| Symbiknow memory verification reproduction.md | `outputs/memory-research/REPRODUCE.md`: commands, isolation and measurement boundaries. |
| Symbiknow PyTorch INT8 verification.md | `outputs/memory-research/followup/README.md`: final matched results, compatibility proof and reproduction. |

The implementation audit corrects the affected focused guides for current model ownership, streaming original transfers, retry/cache/preview boundaries, rebuild journals, canonical project identity, answer-part policy and Overview/readable Map/reader behavior. Unchanged source files keep their current versions. Existing IDs and histories are preserved for updates. Other projects' documents remain outside this selection. The original build checklist, older validation results and six media files retain their historical dates; the 13 October screenshots do not depict the later UI.

`docs/library-sync-2026-10-17-receipt.json` is the operational record for this sync. It records planned request IDs before transfer, source hashes/sizes, current heads, prior history, exact download verification, indexing state and retrieval checks. Read its final status before claiming completion. The receipt is not itself imported as project knowledge. The earlier import/expansion/media receipts remain dated evidence and are not overwritten.

## UI documentation refresh — 19 October 2026
The related implementation guides now document the four fixes verified on 18 October: independent search sort directions, current saved-version timestamps in full/compact MCP and UI results, preview focus restoration, and wrapping toolbar layout. The validation record preserves the focused 95 backend / five Node / five browser test results and their limits. This refresh updates existing document IDs; it does not add a new product feature or replace historical media.

`docs/library-sync-2026-10-19-receipt.json` records source comparisons, version-pinned uploads, exact download/history verification, indexing and retrieval outcomes. Read its final status before treating the refresh as complete. The selected catalog remains 68 Markdown sources and six dated media originals. Unrelated library documents and the separate CDM proposal are outside this UI documentation refresh.

## Folder tool documentation — 19 October 2026

The current API has five MCP tools: upload, download, search, upload_folder and download_folder. The README, UI reference, MCP reference, architecture, operations and affected focused guides describe the additive folder-transfer contract, retry semantics, exact-version ZIP snapshots and limits. Older test results, original plans and 13 October media retain their dates. The operational refresh record is `docs/library-sync-2026-10-19-folder-tools-receipt.json`; inspect its final status for transfer and retrieval verification.

## Documentation consistency refresh — 19 October 2026

The folder-transfer reference now includes guarded member updates and ZIP continuation examples. Related storage and manual-organization guides distinguish UI selection limits from whole-folder MCP export and explain additive imports. The local CDM proposal's synthetic tool inventory and exact source spans also reflect the five-tool API; it remains a proposal outside the selected implementation-library catalog. `docs/library-sync-2026-10-19-docs-refresh-receipt.json` records the changed catalog documents, retained versions and MCP verification for this refresh.
