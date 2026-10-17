# Symbiknow / Search / Neighbor discovery budgets and link coverage

Repository implementation guide. Snapshot: 12 October 2026.

## Candidate discovery precedes judgment
organization_neighbors uses representative content for semantic neighbors and project-scoped lexical candidates. The same-project path compares topical overlap after excluding scope words, reserving up to three preferred neighbors. It also retains global semantic candidates and independently found exact-hash peers.

## Concrete bounds
Semantic discovery requests sixteen document candidates. Scoped lexical discovery requests thirty-two, with up to twenty-four topical tokens. The same-project overlap gate is 0.12. organize_document then considers at most five valid non-hash neighbors; exact duplicate peers are handled separately.

## Why a related pair can be missing
A document can fail to become a candidate because of indexing, scope recognition, lexical/vector retrieval or budget competition. A supplied candidate can then be rejected because its evidence lacks a useful relation or source/target passage support. These failure classes require different fixes.

## Evaluation
Record whether each human-labeled pair was offered and whether the provider accepted it. Measure candidate recall separately from relationship precision/recall. Do not describe five supplied candidates as exhaustive library linking. Same project identity is insufficient to claim a duplicate or useful semantic link.

These bounds are code-snapshot values, not a guarantee that broader retrieval always returns the desired neighbors.

## Source references
- `app/search.py`
- `app/jev.py`
- `tests/test_search.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
