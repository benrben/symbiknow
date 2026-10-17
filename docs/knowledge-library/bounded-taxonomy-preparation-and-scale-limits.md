# Symbiknow / Organization / Bounded taxonomy preparation and scale limits

Repository implementation guide. Snapshot: 12 October 2026.
## Candidate preparation strategy
Topic preparation uses sparse hashed features rather than a document-by-vocabulary dense matrix or unrestricted pairwise hierarchical clustering. The fixed feature budget is 8,192 and the topic/centroid budget is 128. Cluster naming samples at most twenty-four texts. Large buckets use bounded minibatch centroids; smaller buckets use sparse online assignment.

## Scope first
ProjectNames provides exact-name lookup. Shared vocabulary combines explicit paths, ordinary-prose subjects and suitable existing folder names. Rank candidates inside the recognized project scope. Unknown scope is not permission to choose another company's folder. Existing stored vectors can rank a bounded set of scoped prototypes without reembedding every original.

## Why this is not capacity proof
Bounded matrices remove a particular memory-risk pattern. They do not measure total storage, vector/index overhead, OCR model memory, startup reconciliation, per-document hosted latency or long-running reset checkpoints. The entire library can still encounter linear metadata scans and expensive I/O.

## Evaluation distinction
scripts/benchmark-organization.py measures isolated synthetic candidate preparation, excluding a complete import/reset. scripts/evaluate-jev.py can compare labeled grouping outcomes and shuffled runs. Neither should be described as a full 100,000-document / 16 GB product qualification without the real storage/index/model corpus and target host.

Record the exact corpus, hardware, parameters and exclusions when presenting any benchmark. Keep manual corrections durable while candidate/model quality is improved incrementally.

## Source references
- `app/organization.py`
- `scripts/benchmark-organization.py`
- `scripts/evaluate-jev.py`
- `docs/performance-evidence.md`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
