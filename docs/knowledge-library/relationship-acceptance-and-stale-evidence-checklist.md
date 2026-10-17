# Symbiknow / Organization / Relationship acceptance and stale evidence checklist

Repository implementation guide. Snapshot: 12 October 2026.

## From candidate to stored link
A non-hash neighbor must have supplied textual evidence. The provider selects a relation and real source/target passage choices. Current code accepts a meaningful relation only when its confidence passes the configured gate and neither passage choice is none. Unknown choices/invalid numeric outputs are rejected.

## Version validation
A stored link includes source_version, target version and selected chunk IDs. Why linked validates the actual stored link and endpoint evidence. A head update makes an older endpoint unsuitable for current display; history bytes remain downloadable separately.

## Duplicate and direction rules
Hash equality can establish an exact duplicate independent of the ordinary neighbor cap. Model-only duplicate guesses are downgraded to related. Symmetric related/duplicate keys collapse display duplicates while keeping one stable actually stored evidence orientation. Directed support/contradiction is retained.

## Review checklist
Check semantic relation, exact versions, both passage texts and source/target provenance. Avoid inferring evidence from an edge label alone. Identify missing-candidate coverage separately from rejected-provider decisions, and do not use confidence as a precision/recall estimate.

## Limits
This checklist mirrors the evidence contract. It does not certify arbitrary model linking recall or adversarial robustness across a large library.

## Source references
- `app/jev.py`
- `app/ui.py`
- `app/relationships.py`
- `tests/test_jev.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
