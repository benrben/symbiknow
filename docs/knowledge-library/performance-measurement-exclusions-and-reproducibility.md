# Symbiknow / Operations / Performance measurement exclusions and reproducibility

Repository implementation guide. Snapshot: 17 October 2026.

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

## 17 October resource evidence

`Optimize-memory-symbiknow.md` and `outputs/memory-research/followup/` record the matched Apple M5 Pro/48-GB workload. Combined server/child physical-footprint peak fell from 6.06 to 3.98 GiB; with preconversion unloading fixed in both, float32 versus INT8 peaks were 4.49 versus 3.98 GiB. Warm search medians were 186 versus 174 ms, and idle-reload observations were 417 versus 641 ms. Final live idle was 720 MiB; dense scanned-PDF peak was 5.00 GiB. These are different scopes. GPU allocator/driver memory overlaps physical footprint and must not be added. The browser hash comparison did not establish native peak reduction. Generated retrieval labels and synthetic preparation do not establish production quality or 100k/16-GB capacity.

## Source references
- `scripts/benchmark.py`
- `scripts/benchmark-organization.py`
- `frontend/tests/metadata-benchmark.spec.ts`
- `VALIDATION.md`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
