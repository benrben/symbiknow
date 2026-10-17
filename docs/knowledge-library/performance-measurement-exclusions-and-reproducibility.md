# Symbiknow / Operations / Performance measurement exclusions and reproducibility

Repository implementation guide. Snapshot: 12 October 2026.

## Name the measured path
A metadata/UI benchmark measures listing/navigation/rendering over derived rows. A candidate-preparation benchmark measures synthetic topic processing. A runtime probe measures particular embeddings/provider availability. A complete import/reset includes original storage, extraction, model loading/inference, index publication and hosted decisions.

## Required record
Include hardware/RAM, operating system, model/revision/device/dtype/dimension, corpus bytes/pages/chunks, original versus synthetic counts, warm/cold state, query set, concurrency and peak-memory collection method. Publish p50/p95 and failures when sampling enough runs; one elapsed observation is not a percentile.

## Fixture caveat
Synthetic derived rows without original OCFL objects must not be interpreted as a valid real library. Production recovery correctly removes orphaned metadata. A benchmark fixture that disables that recovery for synthetic rows must explicitly disclose it; production must retain the guard.

## Integrity under load
Measure current and historical byte hashes during updates/reset/retries, and separate stored, indexed and organized completion times. A faster query that returns stale content is a regression.

## Current limit
Existing measurements narrow particular risks but leave full 100k-original / 16 GB capacity unproven. Do not convert a successful small fixture into a general latency, memory or recall guarantee.

## Source references
- `scripts/benchmark.py`
- `scripts/benchmark-organization.py`
- `frontend/tests/metadata-benchmark.spec.ts`
- `VALIDATION.md`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
