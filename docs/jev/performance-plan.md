# Jev: tested plan for durable document completion under 2 seconds

Date: 5 October 2026. Status: investigation and implementation plan; the performance target is failing. No production implementation changed during this investigation. The retained app remained stopped; all new provider traffic used offline test doubles or loopback fixtures. No paid provider calls were made.

Subsequent implementation and fresh paired measurements: [simpler document execution results](simpler-document-results.md). The original investigation below is retained as its historical baseline and plan.

## Decision

Replace the chain of separately admitted jobs with one durable document execution plan containing 13 independently verifiable action results. Move execution state and historical records behind an incremental transactional repository. Reuse versioned context and provider answers, but validate current permissions, source versions, ownership, confidence, and exact evidence at commit. Improve concurrency only after persistence supports safe short commits.

Keep the current implementation available during development. Build and test the replacement against copies of the retained fixture. Do not restart the retained app or enable paid calls as part of this plan.

## Evidence collected before planning

The prior report, `jev-all13-storage-result.json`, records 21,298.5 ms for all 13 actions and a durable checkpoint, with 3,011 receipts and a 17,694,838-byte initial ledger.

A fresh run of the same instrumented harness against a temporary copy of the currently retained corpus produced:

| Measurement | Fresh result |
| --- | ---: |
| Existing corpus documents | 158 |
| Initial receipts / proposals | 3,050 / 3,050 |
| Initial ledger bytes | 17,510,654 |
| Admission through durable completion checkpoint | 21,386.5 ms |
| Admission through idle | 21,518.2 ms |
| Workspace reads / writes | 68 / 40 |
| Queue projection reads | 14 |
| Provider HTTP requests / questions | 4 / 462 |
| Local provider handler time, total | 3.65 ms |
| Paid calls | 0 |

Claiming jobs consumed 4,951 ms; continuation 6,502 ms; context building 3,155 ms; recovery 2,635 ms. These are **inclusive, overlapping spans, not additive components**. The harness confirmed all 13 completed jobs, a successful checkpoint, unchanged policy/source/position for the tested document, unchanged pre-existing receipts and their proposals, and an unchanged retained ledger. Its strict unsupported answers exercise a low-provider-latency path; they do not establish useful grouping or every kind of canonical mutation.

The fresh fixture differs from the earlier snapshot. This reproduces the architectural floor, but is not an exact paired comparison. The timer begins before `runtime.run`, and does not yet separate queue wait from active execution. It also includes an observation step inside the instrumented write. Add independent tracing before using this as the new implementation's acceptance harness.

Fresh evidence: [benchmark JSON](performance-plan-evidence/fresh-benchmark.json), [reviewed harness](performance-plan-evidence/benchmark.mts). The harness copies retained data to a private temporary root, excludes settings credentials, redirects every provider request to its loopback server, and removes the copy afterward. It contains local absolute paths and is a diagnostic artifact, not a portable CI runner.

Fresh focused suites passed **257 distinct tests across 25 files**: runtime 65, storage/recovery/Undo 116, provider/grouping 48, and existing UI behavior 28. Exact final counts and commands are in [test evidence](performance-plan-evidence/tests.json). Sandbox attempts that could not bind loopback were rerun with local listener access; those failed attempts are not counted as behavioral passes. These suites validate existing safeguards, not the proposed architecture or the 2-second target. Relevant production source hashes are recorded in [source manifest](performance-plan-evidence/source-hashes.json).

No full ship certification was run: this is a planning task, production files were unchanged, and the configured full gate starts the application. Its startup step conflicts with the instruction to keep the app stopped. No prior certification is represented as fresh evidence.

## Acceptance contract

Record `uploadedAt`, `admittedAt`, `claimRequestedAt`, `claimedAt`, `executionStartedAt`, provider attempts, durable action commits, and `durableCompletedAt`. Use monotonic elapsed spans inside a process and persisted wall timestamps plus attempt IDs across restarts.

Report upload-to-admission, queue wait, claim/lock wait, execution-to-durable-completion, and upload-to-durable-completion separately. Never subtract waiting to claim that every uploaded document finished in two seconds. The execution target is strictly **less than 2,000 ms per document**, including provider calls and durable results/checkpoint; the literal upload-to-completion target must also be shown and remains failing wherever queue wait makes it exceed two seconds. Report every document and maximum, as well as median/p95/p99. Throughput averages are not per-document proof.

A successful checkpoint requires all 13 current action outcomes, all required results/receipts durable, no pending transaction for the plan, and matching current source/dependency/policy/authorization versions. An explicit evidence-backed no-change outcome may count as completed. Failed, interrupted, stale, blocked, and missing results may not. Grouping usefulness is a separate gate.

Count every actual HTTP attempt, including retries and failed requests, against the responsible document plan. Normal eligible plans must use at most two requests. Before executing a plan that needs more, record why: token overflow, genuine dependency depth, changed input, rejection/reselection, or retry. Also report the fraction of documents meeting two requests; exceptions cannot become a blanket exemption.

The earlier real-provider report had 667 ms median and 1,150 ms p95 request latency. Two serial requests of 1,150 ms each would already exceed the budget; this is an illustrative constraint, not a sum of percentiles or a prediction of end-to-end p95. Offline success cannot prove a universal real-provider latency guarantee.

## 1. Incremental durable storage comes first

Current anchors: `server/jev/workspace.ts`, `workspace-codec.ts`, `server/storage-files.ts`, `server/storage-jev-executor.ts`, `server/jev/proposals.ts`.

`read`, `readProgress`, and `readQueued` still read and hash the whole ledger. `write` encodes and replaces it. The cache improves decoding but leaves history-size-dependent I/O and writes. Canonical document plans can contain whole canvas artifacts; moves can span multiple canvases and task boards. The storage serializer is broader than a document lock.

Introduce a repository contract with keyed operations for:

- Workspace settings, vocabulary, policy/authorization epochs and reset state.
- Document plans, leases, action outcomes, completion checkpoints and dependency indexes.
- Immutable proposals, receipts, source/evidence snapshots and checked inverse data, addressed by ID.
- Pending transaction intents and their canonical artifact/read-set references.
- Durable provider answers keyed by exact question inputs and validation versions.

Preferred backend to test: SQLite transactions with WAL and full synchronous durability, using a maintained binding compatible with the repository's supported Node versions. Do not silently require newer Node APIs. The first implementation gate is a standalone repository spike proving packaging/runtime support, crash durability and bounded writes on this fixture. If that gate fails, make an explicit backend decision before migrating; do not improvise a second authoritative store. An append-only checksummed transaction journal is an alternative, but requires torn-tail, sequence, compaction and corruption recovery proofs that SQLite supplies internally.

The durable unit must update action outcomes, receipt/result references, the continuation frontier and final checkpoint atomically where they share a store. Do not write 13 unrelated JSON shards and assume atomicity. Keep source/canvas files in their existing storage initially: persist a prepared intent, apply revision-checked canonical effects, then commit receipts and plan progress. Recovery reconciles a crash between these phases using exact before/after proofs. Metadata-only actions can use one repository transaction; external artifact changes retain the journal protocol.

Import legacy state in staging, preserving all history, unknown extension fields, prepared transactions, reset journals and Undo links. Compare decoded values, IDs and evidence exactly; verify checked Undo on the copy. Flush and switch one versioned manifest atomically. Keep the untouched legacy backup. Before the switch, legacy is authoritative; after it, the new store is authoritative. No ongoing dual writes. A rollback after new commits requires validated reverse migration, not simply repointing to an old backup.

Gate: history growth from 0 to 3,050 to 30,500 unrelated receipts must not cause whole-history reads/writes on the normal document path. Log bytes read/written, fsyncs, lock time, CPU and RSS. Never remove receipts or Undo data to pass.

## 2. One leased document plan, 13 action records

Current anchors: `runtime.ts`, `runtime-queue.ts`, `followups.ts`, `runtime-workspace-completion.ts`.

Create `DocumentExecutionPlan` with a stable plan ID, source identity/incarnation/generation/hash, dependency versions, policy/question schema versions, authorization epoch, lease/fencing token, and 13 action slots. Each action slot contains its read/write sets, dependencies, input fingerprint, status, reason, answer references, result/proposal/receipt IDs and attempt history.

Claim the document once. Evaluate ready nodes using the shared context, persist each completed frontier together with its verified outcomes, and resume the next ready node without another workflow admission. Preserve action-level evaluators, thresholds, evidence checks, receipts and checked Undo. Atomic group commits may contain several independent outcomes; a successful independent node must not be discarded because another node failed. Never mark a batch successful merely because its HTTP request succeeded.

The final transaction writes the thirteenth current outcome and completion checkpoint together when no external canonical work remains. Otherwise write completion only after that work and its receipt are durable. Version-based invalidation must make the checkpoint visibly stale as soon as a relevant edit occurs.

## 3. Reuse context with precise invalidation

Current anchors: `context.ts`, `runtime-question-prefetch.ts`, `runtime-maintenance.ts`, `followup-document-inputs.ts`, `followup-task-inputs.ts`.

Build one validated snapshot per plan; cache parsed passages and candidate indexes by exact source version. Apply committed automatic effects to the in-memory view while preserving manual corrections. Reuse answers, not unchecked mutation objects. Before committing, validate the action's source/read-set versions, relevant vocabulary/tasks, ownership/pins, policy/permission epoch and transaction generation under the commit lock. Recompute only invalidated nodes and their dependents.

Use current content hashes and canonical revision checks for externally editable sources. File size/mtime alone is not a correctness boundary: current native tests deliberately replace bytes while preserving those attributes. Once all writers use a transactional repository, its sequence can validate repository state; external source files still require the appropriate freshness proof.

Recover pending intents at startup and when a dirty transaction epoch changes. Index pending intents so a normal clean action does not scan historical receipts. Reset, Undo, expired leases, interrupted canonical writes and externally detected edits invalidate recovery/context state. A permanent in-memory `recovered=true` flag is unsafe.

## 4. Compile questions into a bounded dependency graph

Current anchors: `actions/automatic.ts`, `actions/question-set-collector.ts`, `actions/question-batch.ts`, `runtime-question-prefetch.ts` and the filing/vocabulary evaluators.

The existing prefetch already shares independent actions. The new planner must remove speculative question multiplication while preserving exact decision inputs:

1. Wave one: profile and independent source/task/link/recall/home decisions; candidate selection and initial evidence selection; vocabulary discovery; quality scores.
2. Wave two: validate selected group/passage purpose, containment and coherence; dependent labels against validated proposed definitions; merge judgments; precise fractional-quality evidence and other genuine followups.

This is a target compilation, not an assumed universal two-wave DAG. Existing-group rejection followed by bootstrap/reselection can need extra depth. Use speculative alternatives only if equivalence tests establish unchanged semantics and the complete request fits the pinned budget. Do not replace all candidate evaluation with a single lossy summary. Preserve each question's exact source scope, stable ID, result schema and validation.

Budget using the actual existing SDK contract, including state, question text, response reserve and aggregate constraints; test boundaries with the pooled wire format. Record budget estimates and why a split occurred. Partition by valid dependency layers and independent sets, not arbitrary contiguous question counts.

Persist valid answers by exact input fingerprint. Represent set/node failures independently; on a failed HTTP chunk, preserve prior successful chunks and unrelated valid outcomes. Handle missing, malformed, reordered and mixed-validity answers explicitly. The current collector can reject all collected sets when its combined operation throws; replacing it must retain isolation across actions.

If a process dies after the provider receives a request but before the answer is durable, local journaling cannot guarantee exactly-once billing. Record an uncertain attempt and use provider idempotency if supported; do not claim duplicate paid work is impossible.

## 5. Short commits and resource-aware scheduling

Current anchors: `runtime-parallel-policy.ts`, `runtime.ts`, `server/storage-jev-executor.ts`.

Evaluation may run concurrently outside mutation locks. Commit under declared conflict resources: document metadata, affected canvas membership, task board, vocabulary definitions and workspace policy. Retain broader canvas/task locks while canonical artifacts are whole-file replacements. Rebuild the mutation against current canonical state under those locks; document locks alone cannot protect whole-canvas writes.

Add lease expiry plus fencing so a restarted or timed-out worker cannot commit after its successor. Select the highest-priority runnable plan, with bounded fairness for waiting exclusive work. Avoid excluding an entire workspace merely because its first candidate conflicts. Cap concurrency based on measured CPU, I/O and provider constraints. Run isolated latency tests separately from burst-throughput tests.

## 6. Timeouts, continuation and repeat-work control

`runtime.ts` currently starts the 15-second timer before `takeJob`; aborted failure can return before continuation. Replace generic cancellation with persisted reason codes: claim timeout, provider timeout, durable-commit timeout, shutdown, user cancellation/pause, permission revoked, policy changed, stale input and provider failure.

Start execution timeout after durable claim. Measure queue/lock time independently; bound claim waiting separately. Treat the 2-second objective as a measured SLO, not an instruction to kill a correct transaction at two seconds. On shutdown or timeout, stop admission, settle or safely journal commit work, and persist the resumable frontier. Do not race an aborted transaction with a replacement worker.

Admission identities distinguish fresh documents, interrupted plans, failed-node retries and legitimate dependency rechecks. Coalesce duplicate admissions using the semantic identity and plan generation. Restart interrupted plans from the first incomplete node; reuse successful unchanged results/answers. Recheck only nodes whose dependency fingerprints changed. Preserve cooldown/backoff for transient provider failures, and expose budget/authorization blocks without retry loops. Manual corrections and changed confidence thresholds must invalidate affected decisions.

## 7. Prove grouping usefulness independently

The saved real-provider report records 139 `insufficient_group_evidence` outcomes and one `no_change`; the grouped document was already manually grouped. The insufficient outcomes had no filing proposals, locating failure before approved-result application. Existing aggregate reports cannot tell which candidates, selections or evidence checks failed.

A fresh [read-only candidate probe](performance-plan-evidence/candidate-probe.json) tested 146 retained documents without invoking a provider. Every document received 24 bootstrap candidates. Of 132 documents with repeated source categories, 130 retained that category candidate; two lost it during admission/ranking. All 132 retained their local category evidence. The eight sampled passages covered a median 23.22% of visible prose, a minimum 1.75%, and less than 10% for 26 documents. Exact offsets were valid and the canonical canvas/ledger remained unchanged. This disproves a universal absence of candidates, identifies two candidate-admission misses to investigate, and highlights limited evidence coverage; it does not establish why all 139 real decisions rejected grouping. The [probe script](performance-plan-evidence/candidate-probe.mts) records the measurement method.

Add a bounded diagnostic trace: discovered candidates and origin, retrieval exclusions, selected candidate, source coverage, selected exact passage, confidence/coherence/purpose/containment decisions, rejection stage, proposal ID, commit guard result and final canonical group. Store IDs and references; do not duplicate source bodies into progress records.

Replay the retained corpus offline with deterministic answers or authorized recorded responses. Measure discovery recall against a small manually reviewed expected-candidate set, including positive groups, ambiguous documents and legitimate no-group cases. Audit title/tags/heading/repeated-caption heuristics, top-candidate truncation, eight-passage sampling and 600-character evidence windows. A corpus probe shows what reaches the evaluator; it is not a semantic verdict.

Test a positive approved grouping end to end through reload, permission/confidence rejection, manual group/pin preservation, and checked Undo. Diagnose the lost stage before changing discovery. Keep thresholds and confidence validation unchanged; forcing a group is not success.

## 8. Bounded document-level progress

Current anchors: `compact-state.ts`, `runtime-read.ts`, `src/useJevWorkspace.ts`, `src/jev-workspace-status.ts`, `src/JevPanel.tsx`.

Publish a small committed projection per document plan: current/stale version, queued/running/interrupted/failed/completed state, 0–13 current outcomes, current phase, queue wait, execution time, retries, next retry and per-action no-change reason. Show completed-with-no-change separately from failed or still waiting. “Done” requires a current durable completion checkpoint, rather than a recent completed action job.

Use a paginated changed-since cursor or bounded delta stream, with scoped authorization on every read and an on-demand details endpoint. Build projections from the same committed sequence as plan outcomes; no false completion before durability. Polling must not load historical receipts, trigger provider work, or reload every document. Coalesce updates and refresh only changed canonical entities. Test restricted viewers, reconnects, stale responses and process restarts.

## Delivery order and ownership

| Stage | Ownership boundary | Exit evidence |
| --- | --- | --- |
| A. Freeze benchmark and trace contract | Integration owner: harness, shared types, acceptance scenarios | Fixture manifest/content hashes; separate queue, execution, provider and commit spans; network allowlist; baseline reproduced |
| B. Incremental repository spike and migration | Storage owner: repository, migration, recovery, Undo | Runtime packaging proven; crash matrix green; exact historical round-trip; bounded-history benchmark |
| C. Document execution plan | Runtime owner: scheduler, leases, context, retry/invalidation | One claim per document; crash-resumable 13-node plan; no repeated unchanged successful work; current checkpoint proof |
| D. Dependency compiler and grouping diagnosis | Decision owner: question planning, isolation, candidate traces | Two requests on eligible cases; explicit exceptions; positive/negative grouping fixtures; preserved thresholds/evidence |
| E. Progress projection | UI/API owner: projection endpoint and document statuses | Bounded reads and payloads; accurate per-document state; no false Done; permission isolation |
| F. Integration and certification | Integration owner after all changes settle | Full retained-fixture offline matrix and performance gates; later full quality gate and real-provider proof only when app/provider restrictions change |

Stages B–D share the plan/repository contracts fixed in A. Storage and runtime integration precede concurrency expansion. Candidate diagnostics and UI read-contract work may proceed independently. With four agents, the integration owner plus storage/runtime/decision owners work concurrently; UI implementation follows the shared contract and frees one ownership slot. Do not have several agents rewrite the same runtime or shared types.

## Offline validation required for the replacement

1. **Durability and recovery:** kill the process before/after claim, intent flush, canonical write, answer persistence, outcome commit, final checkpoint, migration manifest switch and compaction. Reload in a new process. Require no missing results, duplicate effects, false checkpoints or broken Undo; inject ENOSPC/write/fsync/rename failures and corrupted/truncated journals where applicable.
2. **Freshness and permissions:** edit content, replace same-size/same-mtime files, change permission/threshold/policy, move documents, edit tasks/vocabulary, correct manual labels/groups and pin values during provider evaluation. Reject stale effects and recompute only affected dependencies. Position-only edits preserve layout without triggering paid semantic work.
3. **Failure isolation and billing:** one invalid question, one failed chunk, 429/5xx, transport cancellation and restart after a late action fails. Retain valid independent results; resume missing nodes; report every HTTP attempt and uncertain outcome. No paid endpoint is reachable in this suite.
4. **Scheduling:** same-document conflict, same-canvas disjoint edits, two tasks, vocabulary contention, cross-canvas moves, expired lease and stale worker. No lost update; no starvation; claim waiting cannot consume the provider execution timeout.
5. **No-work stability:** repeated maintenance/status polling/reload on unchanged completed documents adds zero provider requests and no new execution plans. Repeat with unrelated history growth. A legitimate dependency edit must still trigger the necessary recheck.
6. **Useful outcomes:** 13 durable action outcomes for fresh documents, positive grouping and legitimate insufficient-evidence cases, labels/links/tasks/ownership/quality/recall/home changes where supported, protected manual state and Undo after reload. No-change-only runs are necessary but insufficient.
7. **Performance:** isolated single-document cold/warm runs, the retained 146-import workload, and history scaling. Freeze content/history/config/code/provider-script hashes and record fixture preparation separately. Use seeded delays and representative recorded latency distributions without sending data externally. Report every document's admission/claim/execution/checkpoint times, request/question/token counts, I/O and peak resources. Run performance measurements without competing coverage/test workers.

Provisional engineering allocation for a two-request path: at most 500 ms for all local execution and durable work, leaving 1,500 ms for provider round trips. This is a design budget to test, not a measured capability. Benchmark metadata-changing and move paths too. Do not tune against only strict no-change answers.

The goal is achieved only when every in-scope document has a current durable all-13 checkpoint below the required timing limit, waiting is explicitly reported, eligible plans meet the request target, grouping evidence is useful where warranted, and preservation/recovery/Undo tests pass. Until a permitted real-provider run also passes, report offline success and live latency as separate statuses.
