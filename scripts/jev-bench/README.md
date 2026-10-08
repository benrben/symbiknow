# Jev action benchmarks

These optional scripts call the actual application question builders, decoders or HTTP APIs using `jev-1.13.0`. They are outside CI. Credentials come from `TYPESAFE_API_KEY` or `data/settings.json` (`secrets.TYPESAFE_API_KEY`); never print the key. The common runner limits each process to two in-flight provider calls, allowing four coordinated workers to stay within eight. SDK retries are capped at two.

`data/atlas` is a frozen repository documentation snapshot. Answer keys are declared before runs. The profile dataset actually has 64 cases, despite the handoff's count of 63; every case is reported. Saved reports are under ignored `out/`. Historical baseline reports were captured before each behavior change and retained with hashes. The runner executes only the current implementation; it has no aliases that would mislabel current behavior as a historical baseline.

Examples from the repository root:

```sh
npm run jev:bench -- duplicates r1
npm run jev:bench -- links r1
npm run jev:bench -- profile r1 atlas
npm run jev:bench -- label r1 atlas
npm run jev:bench -- reflex r1
npm run jev:bench -- vocabulary r1
npm run jev:bench -- file-production r1 atlas-only
npm run jev:bench -- home-production r1 atlas-only
npm run jev:bench -- file-broad-start review --prepare managed
npm run jev:bench -- file-canonical-queue review --prepare
node scripts/jev-bench/home-rules.mjs r1
```

File/home `atlas-only` excludes the three fictional off-topic fixtures from both cases and outbound state. Synthetic home and filing heldout transmission was approved on 2026-10-07. These runs use only made-up documents; other independent corpora still require their own approval. These runners never read application documents, alter production workspace data, or commit changes. HTTP benchmarks create and remove a temporary native store and use the existing local MiniLM model.

Current evidence distinguishes ordinary lifecycle vocabulary judgments from the fully wired automatic path, counts actual wrong moves/merges, and verifies exact source proofs. Search's optional runner exercises shipped `ask_symbi`. Native regressions cover empty user document filters and restricted permissions separately.

The broad-start filing runner begins with all 20 frozen Atlas Markdown documents in Engineering. It runs the actual profile, cached label, and filing actions without adding curated candidate groups. Each document uses its own profile and filing job, as in the automatic queue; a failed profile holds that document's later actions. Failures remain in the report and cause a nonzero exit, while other documents continue. Filing proposals are inspected without applying them to a real workspace. `--prepare` uses explicit offline control answers and sends nothing; its output reviews candidate provenance and bounded payloads, not model quality. `--execute` calls TypeSafe on the frozen corpus under the user's Atlas approval. Optional ownership is `managed`, `manual`, or `pinned`; output reports raw group names, exact evidence, and definition order. Historical 19/19 filing measurements supplied seven existing groups and do not prove group discovery from this starting state.

The separate canonical-queue runner measures preprofiled sequential filing in an isolated native store. It commits the actual checked profile and cached label prerequisites, then runs one public Reflex filing job at a time. Later jobs see earlier applied definitions and memberships; durable reloads and receipts verify the result. Other automatic actions stay disabled, so this is not a replay of the full six-action document plan. Frozen input order, answer keys, strict SDK validation, and the 200-call ceiling remain unchanged. `--prepare` uses offline SDK controls; `--execute` requires the frozen Atlas processing approval. Temporary benchmark writes never modify application workspace data. Raw final groups require semantic review.

Synthetic corpus commands are prepared locally. Home and filing transmission is approved; the other independent corpora require explicit approval before running:

```sh
npm run jev:bench -- duplicates heldout-r1 --heldout
npm run jev:bench -- links heldout-r1 --heldout
npm run jev:bench -- profile heldout-r1 heldout
npm run jev:bench -- label heldout-r1 heldout
npm run jev:bench -- filing-heldout heldout-r1
npm run jev:bench -- home-production heldout-r1 heldout-only
npm run jev:bench -- reflex heldout-r1 heldout-only
npm run jev:bench -- vocabulary independent-r1 --corpus independent-heldout
```

The latest existing-taxonomy filing repeats score 19/19 with root main-purpose checks. Sequential discovery remains uncertified: the final two runs each retain eight frozen documents in Engineering and UI/Canvas placements vary, despite both completing without failed jobs. See `docs/jev/performance-plan-evidence/group-discovery-measured.json` for raw groups, failures, and report hashes.

The latest frozen Atlas home repeats (`home-production-review2-r1.json` and `home-production-review2-r2.json`) each score 16/19 with zero wrong moves. The accuracy target remains unmet.

After the initial TypeSafe HTTP 402 billing errors were resolved on 2026-10-07, both approved heldout repeats per action exited 0. Home scored 10/10 twice with zero wrong moves, compared with the latest Atlas 16/19 twice. Filing scored 12/12 twice with zero off-topic existing-group errors in four cases, compared with Atlas 19/19 with supplied groups. All four off-topic cases bootstrapped their own groups; evaluation did not mutate source documents. Filing heldout evaluates supplied-group placement and off-topic rejection; it does not measure sequential group discovery. No thresholds or question wording were changed in response to heldout results.
