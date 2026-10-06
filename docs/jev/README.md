# Automatic Symbi Reflex and the Jev foundation

Symbi Reflex runs six actions automatically on saved sources. Saving a TypeSafe API key starts processing; opening the Reflex panel is optional. The panel's only settings are six confidence thresholds, one per action, saved automatically. The default is 70%, with a 50–100% range. Progress, findings, source evidence, and saved results remain available for inspection.

| Action | Automatic result |
| --- | --- |
| Understand documents | Save checked roles, passages, and entities. |
| Organize into groups | Place sources in supported groups. |
| Suggest labels | Apply supported labels. |
| Find a home canvas | Move sources when their purpose supports another canvas. |
| Find useful connections | Save evidence-backed relationships. |
| Compare possible duplicates | Record duplicate comparisons. |

Saved source, canvas, group-purpose, vocabulary, people, and threshold changes refresh the relevant checks. New chains group each understood document before labeling and connection checks. Home-canvas movement follows the other dependent actions. Durable context checkpoints prevent repeated processing of unchanged knowledge. Missing provider access is reported as status; unavailable checks retry automatically. Connection configuration stays in ordinary Settings.

**Reset and rerun Jev** clears the generated analysis and organization across all workspace canvases and starts a fresh automatic chain. Owners can invoke it from Reflex with a connected provider. Trusted saved-change provenance identifies generated metadata; manual or ambiguous metadata remains. Source bytes, layout, thresholds, credentials, and correction memory are preserved. Interrupted cleanup resumes from its durable journal before new work begins.

Groups come from recurring source categories and substantive document topics, then Jev checks the document's main purpose against each group's scope and supporting passages. HTML is analyzed as visible prose, excluding templates, styles, and scripts. The saved knowledge index contains roles, representative passages, entities, labels, and relationships. Connection checks find lexical candidates and Jev checks relevance. Raising an action's threshold makes its judgments more selective; profile confidence remains available. Historical quality and recall results remain readable.

Independent judgments share bounded provider requests, with every question restricted to its own source state. Shared grouping and relationship writes remain coordinated, and other workspaces can continue independently. Dependent organization checks retain their ordering. Upload bursts share reconciliation work, and parsed passages use a bounded memory cache. Maintenance shares its owned ledger snapshot and one lazily read organization context within a pass, then starts fresh on the next pass. Admission and execution still check canonical sources and policy. Source guards load each canvas once per invocation, preserving source order and the first failure. Group catalogs compute each source text and topic rank once; neighbor searches tokenize each query once. The UI loads canvas and progress summaries first; opening a source or saved finding loads its detail on demand. Progress and queue projections are cached within a memory budget and checked against the actual file digest. Canonical execution reads retain full validation; restricted users and legacy root extensions retain their scoped canonical read path.

Independent request chunks within a wave run with at most four active calls, preserving answer order. A failure stops new chunk admission and drains started calls before returning the original error. Single-chunk requests and already-aborted waves retain their existing validation order.

Organization checkpoints distinguish manual inputs from trusted automatic outputs. Exact applied receipts project generated document changes back to their input values for the context fingerprint; source changes, manual corrections, group definitions and vocabulary meanings still invalidate it. Vocabulary membership and incidental ordering do not. Root admission rereads pending work inside the workspace queue and includes live runners between completion and continuation, preventing duplicate chains. Each fresh follow-up saves its chain metadata with its initial job write. An action without proposals publishes its result and completion together after all source and policy checks.

Explicit automatic profile and label jobs can refresh only their queued metadata revision before execution, after checking the same source bytes, generation, incarnation, scope and current policy. Manual requests and in-flight evaluations retain their original guards. Maintenance pruning counts removed entries instead of serializing historical recovery proofs to detect a change. These reduce local overhead; the requested end-to-end latency for all six actions has not yet been verified.

The six actions share bounded provider request rounds in a document execution plan. Group and exact-evidence selection precede semantic validation of the selected group and passage. Purpose, coherence, and nested containment checks retain their confidence thresholds. Independent profile, label, connection, duplicate, and home-canvas judgments share work where their dependencies permit it. Exact repeated source objects and question text can share transport references without changing their meaning. Oversized requests split within the provider budget; failures retain action-specific results and recovery paths. Validated answer reuse is bounded and scoped to current source identities, policy, authorization, and provider configuration.

Labels reuse existing document tags and active label definitions. In a fresh workspace without those candidates, local source headings and repeated source categories supply a bounded fallback. Each proposed label still requires semantic support and exact local evidence, and manually removed labels and retired label names stay excluded. This does not discover, merge, or persist a vocabulary. Documents without suitable candidates retain an explicit no-change result.

Pooled source-reference validation visits only recognized fields without copying history. Cold progress and queue reads validate the original encoded ledger, then restore only their projected inputs; canonical reads, Undo and recovery retain independent full snapshots. Every read still checks fresh file bytes, including outside edits that preserve the file size and timestamp.

Durable history shares identical source snapshots and canvas block records in saved receipt and prepared-operation proofs. Version 2 preserves version 1 and legacy JSON reads, exact values, block order and independent restored objects. Proof blocks restore on first access; unchanged unread proofs save their pooled records directly. Reading or replacing those blocks exposes ordinary mutable values, and later edits persist normally. Standalone artifact files and reset journals retain their original encoding. Checked Undo and interrupted-operation recovery continue to validate native proofs.

Automatic writes still check current source identity, scope, evidence, and manually protected fields. Unsupported or protected changes are skipped with a reason. The daemon does not rewrite source content, create tasks, schedule digests, or run removed actions. Requests for removed actions fail with HTTP 400; command-recipe routes are unavailable with HTTP 404.

- [Decision flow](decision-contract.md): what Jev receives and returns.
- [SDK reference](sdk-reference.md): exports, types, limits, retries, and failures.
- [Run the app](../../README.md): development setup and provider connection.
- [Current action contract](decision-contract.md): the six actions and validation boundaries.

The SDK remains independently usable. It returns validated decisions; the application runtime owns authorization, source checks, durable jobs, and checked writes. Chat-agent write proposals still require their own review; they cannot approve themselves. Background Reflex processing independently applies the six retained actions. Internal routes and tools retain the `/jev` namespace.
