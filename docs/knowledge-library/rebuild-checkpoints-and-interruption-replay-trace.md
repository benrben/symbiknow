# Symbiknow / Organization / Rebuild checkpoints and interruption replay trace

Repository implementation guide. Snapshot: 17 October 2026.

## Captured work
A durable reset job records IDs before entering clearing. Selected folder/group/manual and link fields are cleared according to the request. A set of cleared identities avoids linear membership checks as progress grows.

## Example interruption
For a captured thirty-seven-document scope, clearing persists after item thirty-two. If the process stops during item thirty-five, the durable state still identifies thirty-two completed clears. Recovery repeats items thirty-three onward. Repeated clearing is safe because rebuilding has not begun and the operation is idempotent.

## Phase handoff
After remaining clears and any required incoming-link cleanup, the phase becomes rebuilding and is persisted. Original files and histories are untouched by this boundary. Provider preflight occurs before the durable mutation scope, preserving existing organization on an unavailable-provider check.

## What batching improves
The synthetic 1,000-record profile reduced serialized bytes and JSON serialization time with batches of thirty-two. That profile excluded index writes, fsync, model calls and entire-lock duration. It justifies a narrow checkpoint optimization, not a complete reset throughput claim.

## Regression
The batch-checkpoint test simulates an interruption and verifies replay covers only uncheckpointed work while preserving fields excluded from reset. Smaller recovery/concurrency tests remain separate evidence.

## Rebuilding progress journal

The 32-item boundary above applies to clearing. During rebuilding, a captured work roster and cursor avoid regenerating remaining work each item. Compact outcomes append to `organization-rebuild.jsonl` and are fsynced; full snapshots occur at phase/taxonomy boundaries. Checkpoint IDs prevent an old journal tail from contaminating a replaced snapshot. Recovery ignores an interrupted final append. Evidence profiles spill to job-local scratch one document at a time; taxonomy preparation still scales with the captured corpus.

## Source references
- `app/rebuild.py`
- `tests/test_ui_api.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
