# Symbiknow / Organization / Jev answerability labels and safeguards

Repository implementation guide. Snapshot: 13 October 2026.
## Supplied evidence only
Jev receives the user's question and bounded textual evidence for up to eight retrieval candidates, with at most six passages per candidate. Native image vectors with no text are not sent as text answerability material. Hosted provider exceptions are reported without leaking uploaded text in exception bodies.

| Verdict | Meaning |
| --- | --- |
| direct | Explicitly answers all requested parts for the correct entity and applicable status. |
| partial | Supplies at least one requested fact while leaving another part unanswered. |
| related | Relevant entity/subject, but no requested answer fact. |
| unrelated | Different entity or subject with no useful bearing on the question. |
| uncertain | Relevance, entity, applicability or support remains ambiguous. |

## Conservative support
A direct or partial label needs a selected real supplied supporting passage. Without support it becomes uncertain. The support question allows a passage to cover one requested part; the implementation did not lower the probability threshold just to fit one diagnostic. Non-answer verdicts carry no answer-support IDs.

## Presentation
The UI says Supports answer, Partially supports, Related, Not relevant or Needs context. Premise corrections and genuine evidence disagreements have distinct labels. Not checked, visual match and provider-unavailable states remain separate. Confidence is the provider's judgment confidence, not an empirical accuracy guarantee. Historical previews do not inherit current search verdicts.

## Validation
Mocked SDK tests validate schema/evidence behavior. Independent per-class quality requires separately annotated held-out questions and passages, including wrong entities, rejected proposals, multilingual facts and prompt-injection distractors.

## Source references
- `app/jev.py`
- `frontend/src/components/FileList.tsx`
- `app/evaluation.py`
- `tests/test_jev.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.

## Earlier Review 9 policy evidence (13 October 2026)

The earlier source snapshot used prompt `project-first-3/search-evidence-5` and policy `answer-routing-5`. It evaluated up to **six** windows per candidate and eight candidates, using one scoped request per text-bearing document rather than one multi-document request. Each passage had separate entity, explicit obsolete/proposal status, usable-answer and premise-denial judgments. Question-level judgments identified presupposed facts and explicit requests for historical/rejected material. Asking about preservation of historical document contents is a current-behavior question, not automatically a request for an obsolete policy.

`applicability` is a computed status gate: for current questions it complements the raw obsolete/proposed probability. Explicit requests for historical/rejected material admit that status, while entity and answerability still govern usable support. Raw `obsolete` and `historical_request` are retained. This gate does not prove that a source is authoritative or factually correct. Choice confidence remains distribution concentration, not a truth probability.

Existing 0.8 support/entity/status/correction acceptance and 0.6 correction review bands remain. The new premise acceptance/review bands are also 0.8/0.6, and disagreement uses 0.8/0.6. Development receipts preserve both failed combined applicability judgments and the smaller explicit-status comparison. A 0.75/0.8/0.85/0.9 acceptance sweep on development runs produced the same 9/9 corrections and 0/6 false corrections. This small split cannot distinguish those alternatives, so the original 0.8 acceptance bands were retained rather than lowered. Thresholds were checked on authored development cases; there is no independently annotated calibration corpus. The reserved fixtures are self-authored, not independent held-out gold.

Neutral yes/no questions can receive direct negative support without a correction flag. A coherent correction may cite the same passage as both usable support and premise correction; that overlap alone does not imply disagreement. Genuine inconsistency remains uncertain with its supplied citations. Possible corrections never count as accepted corrections in quality metrics. Low-confidence coverage still retains accepted partial evidence while reporting unknown coverage. No accepted correction is not proof that every premise is true.

That snapshot's additive disagreement assessment covered only the supplied windows **within a document**. It did not establish agreement across separate documents or the whole library. The evaluator retained raw judgments, accepted/possible references, coverage, model/prompt/policy versions and separate correction recall, false-conflict, abstention and citation metrics; legacy offline label prediction replay still works.

The exact README no-Git regression succeeds in the saved fresh hosted and HTTP runs, and the neutral query retains negative-answer support. Some reserved paraphrases and the original live reset wording still abstain or provide possible corrections. **R1 remains unresolved for reliable paraphrase coverage.** Receipts, including failures, are in `outputs/mcp-review-9-fixes/`; these observations are not a broad accuracy guarantee.

## Combined Review 9 policy and evidence (13 October 2026)

The combined Review 9 snapshot used prompt `project-first-3/search-evidence-7` and routing policy `answer-routing-7`. Short support criteria accepted usable negative answers and corrections. The premise question separated requests for a selection/location/explanation that assume an action occurs from neutral questions that leave occurrence open. The passage denial question recognized statements that the assumed action, mechanism or state does not happen or exist, including coherent “none” and “nowhere” corrections. No project or storage mechanism was encoded in these criteria. Acceptance remained 0.8 and review remained 0.6; a development sweep retained these bands without lowering them.

The response contract stays additive: `conflicting_chunk_ids`, `possible_conflicting_chunk_ids` and `premise_correction_status` concern the question's assumed facts. `evidence_disagreement` and `disagreement_chunk_ids` concern inconsistent evidence, including disagreement across documents. A single coherent passage may provide both support and a correction. These roles do not by themselves imply disagreement. Unknown coverage keeps accepted support available.

When at least two evaluated documents contain applicable windows, one additional request compares up to two windows per document, selected deterministically by usable-answer or denial probability. The comparison excludes low entity/status gates and raw unrelated labels. It supplies at most sixteen windows across the existing eight-candidate bound; the existing provider semaphore limits concurrent calls to four. It does not compare the complete library, unevaluated candidate tail, or every returned window. Each document exposes only its own cited window IDs. Raw `cross_document_disagreement` probabilities are retained beside the within-document probabilities; `cross_document_assessment` records the compared set, model and usage. A separate comparison cache includes the entire comparison set, namespace, query, model, prompt/policy, context bound and thresholds, so changing a counterpart cannot reuse the old comparison.

Provider failure during comparison retains accepted document support, sets policy label to uncertain and coverage to unknown, and exposes `cross_document_assessment_status=unavailable`. Failed comparison decisions are not cached. Final search publication also checks the compared dependency set; changing a cited counterpart invalidates dependent decisions before they are returned. This preserves the distinction between retrieval availability and assessed agreement.

Fresh final hosted receipts include three attempts per core case: all nine correction-positive attempts were accepted; none of six neutral-negative attempts became premise conflicts. The separate authored reserved corpus repeats eight cases three times: all six correction-positive judgments were accepted, all thirty correction-negative judgments avoided false corrections, and all six genuine disagreement document judgments were uncertain with valid local citations. Wrong-project and obsolete statements did not create disagreement. These are authored regressions, **not independently annotated held-out gold**. The previously exposed seventeen-case matrix still misses one of eight expected corrections: “Which source-control repository holds older Symbiknow file bytes?” with the README's OCFL/no-Git statement. It is retained as a miss rather than silently equating every source-control mechanism with Git. R1's broad variant acceptance remains incomplete.

The evaluator counts possible corrections and provider failures as abstentions. It retains raw decisions, versions, coverage and citation IDs and now reports disagreement counts separately. Historical fixture `expected_support=false` labels on location/branch questions predate the clarification that usable corrections are support; their unexpected-support counts remain visible and should not be treated as evidence that a nonexistent branch/location was invented. Final receipts and scoped latency/token comparisons are in `outputs/review9-combined-fixes/jev/`. See the integrated report for source/runtime reconciliation and final production acceptance.

Official references consulted before editing: [RAG passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages), [Noul](https://docs.typesafe.ai/primitives/noul), and [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13). Installed SDK 0.7.4 was inspected and retained.

## Review 10 follow-up (13 October 2026)

Current source uses prompt `project-first-3/search-evidence-10`, routing policy `answer-routing-10` and context policy `document-call/passage-local-instructions`. The response fields, model, dependencies, candidate/window limits and acceptance/review thresholds are retained. The entity primitive judges named identity alone; different methods or factual disagreement do not change identity. The correction primitive distinguishes an explicitly ruled-out assumption or replacement method for the requested task from compatible additional methods and silence. Usable support asks whether at least one requested part is answered, including partial answers, direct negative answers and corrections. Complete/partial/unknown coverage still comes from the independent document Choice and conservative router.

One request per evaluated document now shares only query and document identity metadata. Each passage primitive receives its own passage in structured instructions. Document Choice and within-document disagreement receive all evaluated windows in their own instructions. This retains the bounded request count while preventing a neighboring correcting passage from donating its claims to unrelated passage IDs. The existing separate cross-document comparison remains bounded and keyed by its complete comparison set.

The Review 10 Git-hosting regression previously had a raw entity probability below 0.8 despite strong denial. A minimal identical-window comparison improved entity judgment, and the identity-only criterion retained the improvement in full scoped requests. The generic source-control repository question needed the explicit replacement-method correction criterion. Context isolation kept the correcting references confined to README v2 t0. Intermediate v8/v9 development failures, including lost neutral/partial support and extraneous neighboring correction IDs, are retained in `outputs/review10-followup/jev/`; only the final v10 results are acceptance evidence.

The pinned eight-case core repeats three fresh times: 12/12 correction-positive attempts accept the correcting passage, 0/12 negatives receive false corrections, and 21/21 expected-support attempts retain support. Both remaining Review 10 questions cite only `ee07d919-4fb8-5af5-848e-69efc0e03aa8:v2:t0` in all three attempts. The original neutral Git question is direct/complete in all three attempts; the compound Files/Canvas control retains partial support in all three. The actual revised limit-8 retrieval shape includes six evaluated README windows and retains direct negative t0 support in three fresh attempts, with no correction flag. Retrieval selection and passage classification remain separately recorded.

Nine authored reserved cases repeat three times: 6/6 positive corrections, 0/21 false corrections, 18/18 expected-support attempts and valid citations throughout. They cover compatible additional methods, another task, wrong entities, silence, current rejected material, explicitly requested proposals, an alternative mechanism and a non-answer footer beside correcting evidence. The compatible-method case retains support with unknown coverage; no stronger completeness claim is made. These fixtures are authored regression evidence, not independent gold or a population accuracy estimate. See `outputs/review10-followup/jev/report.md` and the integrated follow-up report for final runtime verification, calibration counts and remaining limits.
