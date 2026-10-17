# Symbiknow / Architecture / Atomic metadata transactions failure matrix

Repository implementation guide. Snapshot: 12 October 2026.

## Durable records
The manual-organization ledger is atomically written through a temporary file, file fsync, rename and directory fsync. Manual edits persist a prepared transaction before publication. Startup recovery replays recorded decisions, filtering links whose endpoint versions changed, then removes the prepared transaction marker.

| Interruption point | Recovery principle |
| --- | --- |
| Before a prepared ledger exists | Existing published organization remains authoritative. |
| After preparation before all index rows publish | Startup rolls the recorded decisions forward. |
| Ordinary publication failure | The edit path can restore the earlier ledger/rows. |
| During grouping reset clearing | Replay uncheckpointed clears before rebuilding. |
| During filter publication | Reconcile chunk filters from document metadata. |

## Distinguish records from originals
These are derived-organization transactions, not original content commits. They preserve document IDs and content versions. Reset clearing's durable captured scope precedes mutation; its batches permit bounded idempotent replay, not partial success disguised as a finished rebuild.

## Limits
This matrix describes implemented recovery paths and their tests. It does not certify every filesystem power-loss timing or native rocfl interruption. Keep verified backups and separate original-byte validation from index/ledger repair.

## Source references
- `app/organization_edits.py`
- `app/search.py`
- `app/rebuild.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
