# Symbi: lightweight knowledge, automatic organization, and useful MCP tools

Updated: 2026-10-06. Status: implementation plan; unchecked tasks are planned work, not completed features.

This replaces the previous 13-action plan. Documents remain ordinary files. The app keeps six automatic actions and exposes two focused Symbi brain tools through MCP. Existing document, canvas, task, lock, and version tools remain available and receive the improvements below.

## 1. Goals and boundaries

- Save knowledge as normal files without requiring the agent to organize every document manually.
- Find knowledge by meaning, by evidence-based logic, or by combining both.
- Group documents using their logical topics, labels, links, and purpose.
- Keep the app lightweight: local embeddings, SQLite, a bounded memory cache, and no separate Redis or vector database service.
- Target under **2,000 ms of execution per document**, including durable results and a current completion checkpoint. Report queue waiting separately and also show total upload-to-completion time.
- Aim for at most **two Jev provider requests per document where dependencies and token limits allow**. Report every extra request and its reason.
- Preserve content, file formats, manual organization, positions, pins, thresholds, history, Undo, permission checks, and confidence validation.
- This document authorizes no implementation, installations, paid test calls, workspace reset, or app lifecycle changes by itself.

## 2. Files stay files

The existing document files remain the source of truth. SQLite holds only derived search data: text chunks, embeddings, searchable metadata, and rebuildable caches. Deleting the index must not delete knowledge or history; the app can rebuild it from the files and authoritative metadata.

Durable action results, receipts, pending transactions, recovery information, and Undo records remain authoritative application records. They must never exist only in an evictable cache or the rebuildable search index.

## 3. Lightweight components

| Need | Planned choice | Reason |
| --- | --- | --- |
| Fast temporary reuse | Size-limited in-process memory cache | No extra service or network round trip. |
| Persistent search index | SQLite, including FTS5 keyword search | Local file, incremental updates, no database server. |
| Semantic embeddings | `all-MiniLM-L6-v2`, INT8 ONNX | Small local English model; recommended starting point, subject to fixture testing. |
| Model runtime | Transformers.js / ONNX in a bounded worker | Fits the Node app; keeps embedding work off the request event loop. |
| Vector matching | Exact similarity over local vectors | Start simple at the current corpus size; measure before adding an approximate index. |
| Logical judgments | Existing Jev provider | Decide which candidates actually satisfy a question, with source evidence. |

The quantized MiniLM model file is approximately 23 MB. This is not the total installation or RAM footprint. Download a pinned model once, then support offline embedding inference. Split long documents into sections within the model's input limit; do not silently truncate the document to its beginning.

Benchmark Model2Vec `potion-base-8M` as an optional faster alternative if CPU cost becomes a problem. Its published retrieval results are weaker than MiniLM's, so speed alone is insufficient to choose it. These starting models target English; include multilingual examples if the retained documents require them before selecting a model.

Sources: [SQLite serverless design](https://sqlite.org/serverless.html), [SQLite FTS5](https://sqlite.org/fts5.html), [MiniLM model](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), [quantized model files](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/main/onnx), [Transformers.js](https://huggingface.co/docs/transformers.js/en/index), [Model2Vec comparison](https://huggingface.co/minishlab/potion-base-8M).

## 4. One shared index

Processing flow:

`Save file → update changed sections → retrieve candidates → Jev validates meaning → save checked results`

Retrieval combines semantic similarity, keywords, validated topics, labels, role/purpose, and existing links. Grouping, relationship discovery, UI search, and MCP use the same retrieval service.

Every indexed passage carries document identity, canvas scope, source revision/hash, and an exact source reference. Refresh only changed sections. Remove stale entries after deletion or permission/scope changes. Pending indexing must be visible; an incomplete index must not be presented as a complete search of the workspace.

Store first and index asynchronously. If a search needs an unindexed document, perform bounded on-demand work or return a clear indexing status. Do not trigger six automatic actions merely because an agent searches or checks a claim.

### Candidate budgets

| Candidate type | Current limit | Proposed default | Adaptive maximum |
| --- | ---: | ---: | ---: |
| Topic options | 4 | 16 | 32 |
| Relevant neighbors for grouping | 8 | 24 | 48 |
| Documents for link/duplicate checks | 5 | 12 | 24 |

Retrieve a wider pool, initially up to 100 relevant documents, then filter permissions, deduplicate, rank, and choose diverse supporting passages within a token budget. These limits describe candidates, not how many labels, groups, or links must be assigned. Do not fill unused slots with irrelevant results.

Generate topic options from source phrases, headings, existing definitions, and related documents. Deduplicate synonyms and keep exact evidence. Embeddings do not generate topic names, and the current Jev Choice/Score/Noul integration judges supplied options. Any future free-form naming model would be a separate, explicitly measured design change.

## 5. Six internal automatic actions

| Action | Improved behavior |
| --- | --- |
| `profile` | Build a source-backed logical profile: topics, purpose, role, useful entities/project references, and coverage. Reuse its evidence later. |
| `label` | Match validated topics to label definitions and aliases. Preserve manual labels and removals. Reuse earlier judgments only when their predicate and evidence are equivalent. |
| `link` | Evaluate likely useful relationships and their direction, using evidence from both documents. Consider prerequisite, implements, example-of, same-topic, and related where supported. |
| `flag_duplicate` | Use exact hashes and inexpensive overlap checks first, then assess likely semantic duplicates. Distinguish updates and complementary information. Save findings without deleting or merging. |
| `file` | Judge membership against group meaning using topics, labels, links, purpose, and neighbors. Consider supported existing and new groups; preserve manual groups and pins. |
| `suggest_home_canvas` | Match document purpose against canvas scope and indexed contents. Apply existing move policy and reference checks; avoid unnecessary judging when there is only one eligible destination. |

Keep removed actions removed: vocabulary lifecycle, score quality, flag conflict, recheck links, attach document to task, assign owner, and recall. Historical receipts remain readable for recovery and Undo.

### Dynamic document roles

Start with overview, specification, decision, report, instructions, runbook, checklist, meeting notes, reference, proposal, plan, policy, research, incident report, postmortem, tutorial, FAQ, and changelog.

Each role has a stable ID, definition, aliases, and examples. Present a relevant shortlist rather than every role. Allow a primary role and supported secondary roles. New workspace roles require recurring evidence, validation, and deduplication. Keep an insufficient-evidence answer. Catalog maintenance is part of the profile/index design, not a restored standalone vocabulary action.

### Better questions and reuse

- Audit every existing question: what decision uses the answer, how are options generated, and which evidence is required?
- Remove unused questions, including duplicate-check usefulness scoring where its answer has no downstream effect.
- Share parsed sources and compatible validated evidence across actions.
- Cache symmetric duplicate checks by unordered document pair; keep directional links distinct.
- Do not force duplicate and related into mutually exclusive outcomes.
- Cache group-definition validation by definition and source revision; still validate each membership.
- Keep insufficient evidence and no-change outcomes valid. Do not lower thresholds to manufacture grouping.
- Treat document text as untrusted input regardless of any paid profile question about instructions addressed to AI.

## 6. Two Symbi brain tools through MCP

Expose **`ask_symbi`** and **`symbi_reflex`** as the default agent-facing brain tools. The six automatic actions stay internal. Existing file, canvas, task, lock, and version operations remain normal MCP tools; “two tools” refers to the brain interface, not the entire MCP server.

### `ask_symbi`: find knowledge and navigate

Input concept: question, mode, optional canvas/document scope, result limit/cursor, and explicit navigation intent. Use a bounded search budget.

| Mode | Behavior |
| --- | --- |
| `semantic` | Local embeddings retrieve similar meaning, supported by local keyword/metadata evidence. No paid Jev inference. |
| `logic` | Retrieve scoped evidence using local text, metadata, and graph search; Jev evaluates whether it answers the question. Expand within budget when needed. This does not scan every file in the workspace by default. |
| `combined` | Semantic and keyword retrieval discover candidates; Jev evaluates which candidates actually answer the question. |

Examples:

- “Find our rollback instructions.”
- “Which documents explain why we changed the release process?”
- “Find the employee onboarding canvas.”
- “Take me to the canvas containing the release checklist.”

Return matching documents/canvases, exact excerpts, reasons, coverage/freshness, and navigation links. Return provider usage and request count for logical modes. Provide bounded continuation/job status through this interface when work cannot finish immediately; polling must not restart paid work.

Explicit navigation may change the connected UI's active canvas, within its granted scope. A headless client receives a deep link. Searching alone must not move documents or switch an unrelated user's UI session. If the intended destination is ambiguous, return candidate canvases rather than silently selecting one.

### `symbi_reflex`: check a claim

Input concept: a question/claim plus document IDs or canvas scope and an optional comparison target.

Examples:

- “Does this document belong in this canvas?”
- “Do these two documents describe the same procedure?”
- “Does this canvas contain a rollback plan?”
- “Does this document support this decision?”

Return `yes`, `no`, or `insufficient_evidence`, with confidence, a short explanation, supporting passages, checked scope, and coverage/freshness. A failed search is not proof that something does not exist. A negative answer must be justified by the question and evidence coverage.

This tool checks claims. It does not apply organization changes, edit content, merge duplicates, or run all six actions. Reuse still-valid judgments and disclose paid provider usage.

### Memory behavior and permissions

Agents save knowledge using existing create/upload/edit tools. They do not need to provide topics, embeddings, or group assignments. Source files remain immediately durable; indexing and authorized background organization are separate visible states.

Apply permissions before gathering evidence or sending it to Jev, and again before any authorized mutation. Cache reuse must respect principal/scope, source versions, model/question versions, and relevant policy/catalog changes. Read-only logical checks may use inference only under the workspace's configured provider policy; read permission must never imply write permission.

## 7. Non-Jev MCP improvements from the supplied review

The supplied review tested only 3–4 documents and includes predicted large-canvas problems. Treat its findings as reported observations to reproduce, not as independently proven failures. Priorities below retain the review's intent. Each checked-off task must have a verified behavior or a documented reason no change is needed.

### Documents and canvases

| Task | Priority | Tool | Work and acceptance |
| --- | --- | --- | --- |
| [ ] MCP-01 | Low | `list_canvases` | Return authorized document counts and clearly defined last-updated timestamps without reading every body. |
| [ ] MCP-02 | High | `read_canvas` | Add `includeContent: false` for titles, IDs, positions, groups, links, locks, and revisions only. Make summaries the documented agent workflow; handle any default change through compatibility/versioning. Add pagination for large canvases. |
| [ ] MCP-03 | Verify | `read_doc` | Preserve full source and hash behavior; test format fidelity and scope. Extend with explicit branch reads in MCP-14. |
| [ ] MCP-04 | Low | `search_docs` | Add `canvasId`, `limit`, and bounded pagination. Preserve evidence passages and permission filtering. Keep ordinary search local and free of hidden Jev calls. |
| [ ] MCP-05 | Medium | `create_doc` | Reproduce HTML reported as Markdown. Return the effective document kind consistently with rendering/export, even if its physical storage uses a Markdown wrapper. |
| [ ] MCP-06 | Medium | `upload_file` | Require `expectedContentHash` when replacing an existing `blockId`. Atomically check hash and lock before replacement. New uploads need no previous hash. |
| [ ] MCP-07 | Medium | `edit_doc` | Require the appropriate expected revision/hash for existing-document edits. Return the authorized current hash in structured conflict errors. An agent must reread/merge changed content before retrying; the returned hash is not permission for a blind overwrite. |
| [ ] MCP-08 | Verify | `download_file` | Preserve complete source, filename, content hash, and existing local overwrite protections. |
| [ ] MCP-09 | Medium | `delete_doc` | Reproduce reported guard gaps. Respect other actors' locks; add and enforce an expected content hash for deletion under the new contract. Keep conflict checks atomic. |
| [ ] MCP-10 | Low | `move_block` | Return a compact ID, position, and relevant revision acknowledgment rather than full document text. |
| [ ] MCP-11 | Low | `link_blocks`, `unlink_blocks` | Return IDs, updated links, and relevant revision only. Make link updates atomic so concurrent changes are preserved. |

### Locks and versions

| Task | Priority | Tool | Work and acceptance |
| --- | --- | --- | --- |
| [ ] MCP-12 | Low | `claim_doc` | Return the current content hash with lock acquisition. Keep compare-and-swap checks on later writes because a lock response is not a permanent freshness guarantee. |
| [ ] MCP-13 | Verify | `release_doc` | Preserve behavior; cover ownership, expiry, permissions, and release after failures. |
| [ ] MCP-14 | High | `switch_branch`, `read_doc`, `edit_doc` | Introduce explicit branch-targeted reads/edits that do not switch the shared visible document for everyone. Define per-branch revisions, history, locks, and index visibility. Retain legacy shared switching only as an explicitly documented workspace mutation until migrated. |
| [ ] MCP-15 | Low | `list_versions` | Normalize timestamps to UTC ISO 8601 and add `limit`/pagination while preserving actual instants. |
| [ ] MCP-16 | Verify | `create_branch` | Preserve behavior and verify it against the branch-isolation design. |
| [ ] MCP-17 | Medium | `merge_branch` | Add safe branch cleanup through `delete_branch` or an explicit delete-after-successful-merge option. Guard current/protected branches and unmerged work. Preserve conflicts and do not delete on failed merge. |
| [ ] MCP-18 | Verify | `restore_revision` | Preserve source/history behavior and verify current lock, revision, and index invalidation protections. |

### Tasks

The **Tasks page is a board built from the regular canvas UI**. Show tasks as canvas cards, grouped and positioned by their status. Reuse the canvas's pan, zoom, card selection, and group presentation, with a board layout controlled by task status.

Display four status groups as columns, always in this left-to-right order:

**To do → In progress → Blocked → Done**

Map these labels to the existing `todo`, `in_progress`, `blocked`, and `done` values. Keep empty columns visible so the board structure stays predictable. Stack cards vertically inside each column with consistent spacing; use stable ordering so refreshes do not shuffle tasks. Status determines the column, and ordering within the column determines the card's position.

Each card shows its title, assignee, and linked-document indicators. Selecting a card opens its details, comments, and document links. Creating a task inside a column gives it that column's status. Dragging a card to another column updates its actual task status; dragging within a column updates its saved order. Provide an accessible status control as an alternative to dragging.

The board and MCP use the same task records. A status change through `update_task` moves the card to the correct column, and a board change is immediately reflected in MCP reads after saving. Preserve permissions, conflict checks, and durable task history. If a save fails, restore the last saved position and show the error. Status groups are fixed board structure, not Jev-generated document groups; task moves must not rearrange document cards on the ordinary canvas.

| Task | Priority | Tool | Work and acceptance |
| --- | --- | --- | --- |
| [ ] MCP-19 | Verify | `create_task` | Preserve behavior and scoped document references. |
| [ ] MCP-20 | Low | `list_tasks` | Add `status`, `assignee`, and bounded pagination. |
| [ ] MCP-21 | Verify | `claim_task` | Preserve ownership/concurrency behavior. |
| [ ] MCP-22 | Verify | `comment_task` | Preserve attribution and scoped access. |
| [ ] MCP-23 | Low | `update_task` | Preserve updates and add `delete_task` with permission checks and a defined policy for comments, document references, and historical audit records. |

## 8. Migrate existing Jev MCP tools

The new two-tool design supersedes expanding the old brain-tool catalog. Preserve a documented compatibility period for clients that still call old tools; default discovery and agent instructions should teach the two new tools. UI/admin diagnostics can remain available without adding more default brain tools.

| Task | Existing tool/area | Review finding and migration work |
| --- | --- | --- |
| [ ] LEG-01 | `jev_activity` | Review reports ignored filters and a 132 KB response for three docs. Honor document/query filters, newest-first limits/cursors, and compact job summaries in any retained diagnostic/compatibility endpoint. |
| [ ] LEG-02 | `related` | Review reports self-analysis instead of related documents. Route compatibility behavior to actual linked, same-group, and same-topic retrieval used by `ask_symbi`. |
| [ ] LEG-03 | `find_by` | Review reports profile-only searching. Replace with shared source-text/semantic retrieval; deprecate the ambiguous alias. |
| [ ] LEG-04 | `jev_profile` | Preserve scoped profile inspection where needed and disclose passage/coverage limits. A profile summary must not stand in for searching complete indexed sources. |
| [ ] LEG-05 | `memory_map` | Honor document/query filters and limits; use compact group/canvas projections for navigation and diagnostics. |
| [ ] LEG-06 | `brain_inbox` | Honor document/query filters and pagination. An empty test inbox is not proof those filters work. Keep review state distinct from automatic completion. |
| [ ] LEG-07 | `jev_do` | Remove from default brain discovery. During compatibility, describe its actual proposal behavior accurately; do not relabel it “execute” without implementing separate authorized execution semantics. |
| [ ] LEG-08 | `jev_propose` | Preserve reviewer-bound proposal semantics during compatibility, then migrate callers away from the default brain surface. Do not expose six actions through the new claim-checking tool. |
| [ ] LEG-09 | `jev_job` | Preserve scoped job lookup for existing clients/diagnostics. Return compact current progress; integrate continuation/status into the new tool contracts without introducing a third default brain tool. |
| [ ] LEG-10 | Edit-triggered jobs | Reproduce the reported 90 jobs in a minute. Debounce rapid edits, replace superseded queued revisions, and avoid paid processing of stale work. Keep required cancellation/recovery records but suppress noisy skipped-job entries in normal activity. |

## 9. Execution, durable storage, and progress

- Build one document-level plan and share validated context across six action outcomes.
- Target round one for independent profile/topic/label/pair judgments and round two for dependent grouping and placement decisions. Exact dependencies and provider budgets determine the final split.
- Keep failure isolation: one invalid answer must not authorize unrelated changes or erase successful durable outcomes.
- Persist small changed execution records/receipts rather than rewriting unrelated workspace history at every step. Design journal/compaction and recovery before migrating the authoritative storage format.
- Validate source revisions, permissions, thresholds, and pending transactions at mutation boundaries; reuse proofs only while their dependencies remain valid.
- Use document-scoped coordination where safe. Serialize overlapping mutations and preserve workspace-level invariants. More workers alone are not the storage fix.
- Separate queue/claim waiting, indexing, provider execution, durable commit, cancellation, and shutdown timeout reasons.
- Resume interrupted chains from valid durable results. Distinguish new documents, interrupted work, legitimate rechecks, and explicit reruns.
- Coalesce edit bursts with a short configurable quiet window; account for that wait explicitly. Fresh imports should not incur an unnecessary edit-debounce delay.
- UI and MCP read the same compact versioned progress projection. Polling must not repeatedly scan receipt history, create jobs, or start paid inference.
- Show each action as changed, no change with reason, failed, or waiting. Show a document complete only after the current checkpoint is durable.

## 10. Implementation tasks and order

### Phase A — Baseline and contracts

- [ ] A1. Reproduce the pasted MCP findings with a small fixture; label unconfirmed predictions clearly.
- [ ] A2. Preserve a baseline on the retained real-data fixture without altering the live workspace. Record per-document timings, question counts, requests, tokens, reads/writes, and bytes processed.
- [ ] A3. Create expected retrieval, grouping, link, and duplicate outcomes, including ambiguous and unrelated cases.
- [ ] A4. Define versioned schemas for both brain tools, index records, progress, conflict errors, and MCP compatibility.
- [ ] A5. Audit every retained automatic action/question: inputs, option sources, dependencies, cache validity, cost, and downstream use.

### Phase B — Lightweight index

- [ ] B1. Add a rebuildable SQLite index with FTS5, source-referenced chunks, model versioning, and permission scope.
- [ ] B2. Add pinned local INT8 MiniLM inference in a bounded worker, with offline loading and whole-document chunk coverage.
- [ ] B3. Implement incremental updates, deletion cleanup, restart recovery, and a bounded memory cache.
- [ ] B4. Combine keyword, semantic, metadata, and graph retrieval; add the larger configurable candidate limits.
- [ ] B5. Measure MiniLM quality/CPU/RAM against the current retrieval baseline; compare Potion-8M only if useful for the resource budget.

### Phase C — Smarter six-action pipeline

- [ ] C1. Expand and validate the role catalog and evidence-backed topic candidates.
- [ ] C2. Reuse equivalent judgments; remove unused questions; deduplicate pair checks with correct directionality.
- [ ] C3. Improve labels, typed links, duplicate discrimination, group membership, and canvas-purpose selection.
- [ ] C4. Build bounded dependency-aware provider rounds and explain extra requests.
- [ ] C5. Implement compact durable updates, safe scheduling, continuation, and separate timeout reasons.
- [ ] C6. Implement revision-aware debounce and current checkpoints that do not loop after automatic metadata changes.

### Phase D — MCP and UI

- [ ] D1. Implement `ask_symbi` with semantic, logic, combined, scoped continuation, and explicit navigation.
- [ ] D2. Implement `symbi_reflex` with yes/no/insufficient-evidence results and exact support.
- [ ] D3. Complete MCP-01 through MCP-23, prioritizing bounded canvas reads, safe writes/deletes, and isolated branch work.
- [ ] D4. Complete LEG-01 through LEG-10 and migrate default brain discovery/instructions to the two new tools.
- [ ] D5. Add retry-safe document imports with idempotency keys and compact document/revision/processing acknowledgments; support bounded batch imports with per-document errors.
- [ ] D6. Add shared compact progress and on-demand decision inspection, including options, candidate origins, confidence, and no-change reasons.
- [ ] D7. Build the Tasks page using the regular canvas components, with visible status columns ordered To do, In progress, Blocked, Done and task cards positioned automatically within them.
- [ ] D8. Implement task details, creation within a status column, drag-to-change-status, saved within-column ordering, and an accessible status control. Keep board edits and MCP task updates synchronized through the same guarded task service.
- [ ] D9. Verify the task board with empty columns, many tasks, reloads, concurrent updates, failed saves, keyboard interaction, and MCP-triggered status changes. Confirm document positions and document groups remain unchanged.

### Phase E — Proof and rollout

- [ ] E1. Compare current behavior, larger limits alone, shared-question reuse, and the full hybrid design.
- [ ] E2. Run correctness, scope, concurrency, restart, cancellation, Undo, and MCP compatibility tests.
- [ ] E3. Measure cold/warm resource use and latency on small and retained real-data fixtures; include indexing and model startup costs.
- [ ] E4. Validate with offline/local provider fixtures first. Perform any bounded real-provider verification only within applicable user authorization and report actual cost/request counts.
- [ ] E5. Roll out behind reversible configuration, with rebuildable index migration and existing durable history preserved.

## 11. Acceptance and measurement

The previous five-document probe reported execution around 0.83–1.31 seconds and 2–4 provider requests per document. It used small synthetic documents and does not prove the retained full workspace meets the target. Its 277 questions included 168 link/duplicate questions, identifying a concrete optimization area. Baseline artifact: [prior results](work/jev-logical-grouping-scope-20261006/results.json).

Required proof:

- All six outcomes and the current checkpoint survive restart; no prepared transaction is abandoned.
- Every file's bytes, manual metadata, positions, pins, thresholds, history, and Undo behavior remain correct.
- Deleted or inaccessible sources never appear in results, evidence, caches, or provider payloads for unauthorized callers.
- Semantic search works offline after model installation and makes zero paid inference requests.
- Logic/combined searches and claim checks report evidence coverage, provider usage, and honest insufficient-evidence results.
- Search/check calls do not run organization actions, edit sources, or start unrelated paid jobs.
- Larger candidate sets improve measured retrieval coverage without unacceptable losses in grouping/link precision; test distractors and option ordering as well as happy paths.
- Long documents, paraphrases, ambiguous purposes, multi-topic documents, updates, and missing evidence are covered.
- MCP metadata reads and mutation acknowledgments remain bounded as document bodies and history grow.
- The Tasks page renders a regular-canvas-style board with all four status groups in the specified order. Each task appears once in its current status column; ordering survives reloads, and changes from either MCP or the UI update the same durable task record.
- Branch edits by one agent cannot silently switch another agent's working document.
- Repeated imports, polls, retries, edits, and reconnects do not duplicate documents or paid work.
- Report p50, p95, and maximum per-document execution; list every miss of the 2,000 ms target. Also report queue wait, full upload-to-durable time, total batch time, cold startup, CPU, peak RAM, disk growth, and provider requests/questions/tokens.
- Count all external requests. Embeddings are local in this design, but their CPU time remains part of the end-to-end measurement.

Keep the app usable while indexing or Jev is unavailable. Explain degraded or pending results rather than claiming complete knowledge. Do not force groups, lower confidence thresholds, or hide queue time to pass performance tests.

## 12. Review-note provenance

MCP tasks above incorporate every tool discussed in the supplied 33-tool review, including tools marked “no change needed” as regression checks. The source also supplied the edit-triggered job observation. Its suggested execution semantics for `jev_do` have been reconciled with the newer two-tool plan and existing proposal permissions.

Source: [user-supplied MCP review](</Users/benreich/.codex/attachments/d2909977-75f8-444a-ba16-ad8505bd9691/Pasted text.txt>).

## 13. Future canvas presentation improvements — plan only

The following work is deferred. Do not implement it as part of the current plan execution.

- Make document groups and card positions on the human-facing canvas reflect the logical topics, purposes, and relationships found by the shared retrieval and Jev pipeline. Arrange related material in a way people can understand and navigate, while preserving manual groups, positions, pins, and Undo.
- Expose the same logical group and placement information through MCP so an agent can search and navigate the canvas intelligently for a human. Agent search results should identify the relevant canvas area and explain why it is relevant; search itself must not silently rearrange cards.
- Make links explainable in the UI. A person should be able to inspect a link and see its relationship type, the reason it was suggested or added, and the source evidence used for that judgment. Distinguish manual links from automatic links and preserve manual edits.
- Define acceptance tests for stable grouping and layout across reloads, clear handling of ambiguous or unrelated documents, permission-safe MCP navigation, and link explanations that remain valid when source documents change.
