# Simpler document execution: implementation and offline results

5 October 2026. Implemented and tested locally. **The simpler path is 9.56× faster on the retained-fixture test, but total completion still exceeds 2,000 ms.** The app stayed stopped and paid provider calls stayed disabled.

## Final paired measurement

Both runs used the frozen source, separate temporary copies of the same retained corpus, and the same instant loopback provider. They ran serially after tests stopped. The fixture retained 158 existing documents, 3,050 receipts, 3,050 proposals, and a 17,510,654-byte initial workspace ledger. One representative document was cloned and processed in each copy. Copied pending jobs were cancelled to isolate that document; retained data was untouched.

| Measurement | Existing action chain | Simpler document operation |
| --- | ---: | ---: |
| Admission invocation → durable current checkpoint | 21,845 ms | **2,285 ms** |
| Root claim returned → durable completion | 20,785 ms | **1,235 ms** |
| Workspace reads | 68 | **4** |
| Workspace writes / durable revisions | 40 | **3** |
| Additional queue projection reads | 14 | **2** |
| Provider HTTP requests | 4 | **2** |
| Provider questions | 462 | **174** |
| Completed action outcomes | 13 | **13** |
| Paid provider calls | 0 | **0** |

The final simpler run spent approximately 495 ms in admission, 176 ms waiting between durable admission and claim invocation, 380 ms claiming, and 1,235 ms after the durable claim. The latter includes 226 ms of context setup. These measured boundaries are defined in the JSON; rounded components and admission-return boundaries are not perfectly additive. Other instrumented stage timings are inclusive and overlap.

The strict total target is **failing by 285 ms**, even with an instant provider. Measuring only execution after claiming would conceal admission and waiting. This harness starts at runtime admission, not file upload, so it also does not certify upload-to-completion latency. A single representative document is not a distribution or proof that every document meets the target.

Evidence: [legacy run](../../work/jev-simple-20261005/legacy.json), [simpler run](../../work/jev-simple-20261005/simple.json), [harness](../../work/jev-simple-20261005/benchmark.mts), [frozen source hashes](../../work/jev-simple-20261005/source-hashes-final.json). The harness uses local absolute paths and is a diagnostic tool. Its strict unsupported answers measure application overhead with real persistence; they do not establish real-provider latency or useful grouping.

Both runs verified all 13 completed jobs, an exact recomputation of the current completion checkpoint, unchanged policy/source/content/position, unchanged historical receipts and their proposals, and an unchanged retained ledger.

## What changed

An eligible automatic single-document run now has one claimed root operation with 13 separate outcomes. It shares validated context and stages compatible workspace-only results, receipts and no-change decisions. Admission, claim and final completion account for the three writes in the measured path. The last write includes the completion checkpoint.

Actual canvas/task changes continue through the canonical transaction journal and checked Undo. They can require additional writes. Source and supporting-context edits, vocabulary/task changes, permission changes, cancellation and pending transactions are checked at durable boundaries. Persisted context proofs advance only through the operation's own checked receipts.

Successful prefixes survive provider failures, invalid returned evaluations and rejected workspace mutations. Retries resume the missing suffix. Shutdown or timeout while waiting for the native writer cannot begin a canonical effect afterward. The execution timer starts after claiming. Unchanged completed documents do not trigger new decisions in the acceptance test.

Group assessment selects candidate evidence first and performs semantic checks on selected evidence. Evidence-selection payloads omit repeated fields needed only for semantic validation. Exact source text, candidates, thresholds and selected semantic validation remain. A new large native budget regression went from four requests before that payload fix to two afterward.

The document path is enabled by default for the built-in evaluator only when the exact automation principal requests a single document and all 13 actions are automatic. Other scopes retain the existing action path. The existing path also remains selectable for comparison.

## Why 13 actions produced hundreds of questions

The 13 outcomes are: profile the document; file it into a group; maintain vocabulary; apply labels; assess quality; propose links; flag duplicates; flag conflicts; recheck existing links; attach supporting documents to tasks; assign task owners; retrieve relevant evidence; and suggest a home canvas. Inapplicable actions can complete with an explicit no-change result and no provider questions.

The measured 174 questions still include candidate fan-out: 60 graph checks, 32 concept-discovery questions, 25 bootstrap-group questions, 24 recall checks, 20 quality questions, 7 existing-group selection/evidence questions, 3 profile questions, 2 vocabulary-merge questions and 1 home-canvas question. Thirteen outcomes do not require thirteen separate workflows, nor do they imply exactly thirteen provider questions. Further reduction should target speculative candidates and dependent evidence questions while preserving failure isolation and validation.

The original 68 reads and 40 writes came from repeatedly entering admission, claiming, context construction, recovery, result persistence and follow-up scheduling. These were workspace-state operations, repeatedly processing other documents' history. This iteration removes most repetitions; it still uses whole-workspace snapshots rather than incremental storage.

## Validation and limits

- Final frozen regression suite: **3,922 passed, 0 failed, 0 skipped across 381 files**.
- Offline public-runtime acceptance: **1 scenario, 7 steps passed**, including reload, three writes, manual organization/position preservation and unchanged-document rechecks.
- Final production build passed. Selected quality checks passed for repository lint, types and the 600-line file limit.
- Native tests cover durable separate receipts, Undo, canonical crash recovery, stale supporting evidence, manual edits, task/vocabulary changes, revoked permissions, aborted lock waits, provider changes and partial failure/retry.
- Source hashes were checked after the final measurements. No application listeners remained on ports 8787 or 5173.

[Test summary](../../work/jev-simple-20261005/test-summary.json), [full regression report](../../work/jev-simple-20261005/regression-tests.json), [acceptance report](../../work/jev-simple-20261005/acceptance.json), [selected quality report](../../work/jev-simple-20261005/quality/quality-gate-report.html).

This is not full ship certification. The configured full gate starts the application, conflicting with the instruction to keep it stopped; browser smoke and full browser acceptance were not run. No fresh full coverage/complexity certification is claimed.

The remaining architectural work is incremental durable storage, bounded candidate discovery, explicit document progress in the UI, and retained-corpus throughput/positive-grouping measurements. Workspace-exclusive scheduling is still conservative. Larger batches can retain more child action records, and useful canonical changes cost more than this no-change floor. Real-provider validation and the every-document 2-second goal remain unproven.
