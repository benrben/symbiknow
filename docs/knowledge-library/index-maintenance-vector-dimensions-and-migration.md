# Symbiknow / Search / Index maintenance vector dimensions and migration

Repository implementation guide. Snapshot: 12 October 2026.

## Maintenance entry point
maintain_index is documented for use while the daemon is stopped. It delegates index creation and compaction to LanceDB. It creates scalar indexes on document identity and active/folder/model fields and optimizes metadata/chunk tables.

## Small versus large vector tables
Below 1,024 chunks the implementation leaves vector search as an exact scan. At or above that threshold it creates a cosine IVF_SQ vector index with bounded partitions derived from chunk count, up to 256. This is an implementation policy, not a measured universal optimum.

## Dimension compatibility
The chunks schema fixes the vector dimension. put_chunks rejects new vectors whose width differs from the existing schema. The adapter permits configured 128/256/512/768 dimensions, but changing configuration alone does not migrate a stored index.

## Safe migration discipline
Stop the owner, retain a verified full backup and record model/revision/dimension. Plan reconstruction of derived vectors from preserved originals. Validate current/historical hashes and representative retrieval after migration. Do not rewrite original content versions to repair a vector schema.

## Measurement
Compare query latency, recall and memory before changing index parameters. Existing synthetic candidate/metadata measurements do not prove performance for a full original corpus or every dimension.

## Source references
- `app/search.py`
- `app/embeddings.py`
- `docs/operations.md`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
