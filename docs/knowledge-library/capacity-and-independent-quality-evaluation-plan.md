# Symbiknow / Operations / Capacity and independent quality evaluation plan

Repository implementation guide. Snapshot: 12 October 2026.
## Separate the questions
Byte integrity, retrieval latency, grouping usefulness and answerability accuracy are different measurements. A synthetic metadata table can assess a UI/metadata path while excluding original storage, OCR, embedding runtime and hosted calls. Bounded topic preparation is not a whole-library reset benchmark.

## Capacity stages
For a future target-scale qualification, stage real 1k/10k/100k original corpora with mixed text, PDF and images. Record host RAM/device, corpus bytes/pages/chunks, model/dimension, cold/warm startup, import/update/reset/retry durations, p50/p95 query latency and sustained peak memory. Preserve exact historical-byte checks under concurrent load. The current 100,000-document / 16 GB target remains unverified.

A narrow 1,000-document synthetic reset-record profile measured JSON serialization only: per-item checkpoints serialized 113,133,000 bytes in 0.1652s; thirty-two batched checkpoints serialized 3,651,072 bytes in 0.0053s. Those values exclude index writes, storage, fsync and models and are not a measured whole-reset speedup.

## Quality harness
scripts/evaluate-jev.py accepts an explicitly labeled JSON corpus with annotator/split provenance and either --live hosted calls or saved --predictions. It never reads the app library. Report per-class answerability precision/recall/confusion, pairwise grouping precision/recall, singleton/Unfiled rates and co-membership stability across shuffled runs.

Use separately annotated held-out entities, topic pairs, multilingual/OCR material and adversarial distractors. Developer-authored known regressions are useful contracts but are not independent gold. Do not score naming synonyms solely by exact folder strings or claim a small diagnostic accuracy percentage.

## Source references
- `scripts/benchmark.py`
- `scripts/benchmark-organization.py`
- `scripts/evaluate-jev.py`
- `app/evaluation.py`
- `VALIDATION.md`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
