# Symbiknow / Organization / Relationships deduplication and link evidence

Repository implementation guide. Snapshot: 12 October 2026.
## Relationship types
Jev can classify supplied neighboring evidence as related, supports, contradicts, duplicate or no useful relationship. A stored useful link includes real source/target passage IDs and endpoint versions. Bounded neighbor discovery does not guarantee every relevant pair will be offered or accepted.

## Duplicate rule
Whole-file SHA-256 peers independently establish exact duplicates. A model guess based on passage similarity cannot establish complete-content equivalence. Model-proposed duplicate relationships for non-hash peers are presented as related rather than falsely claiming equal originals.

## Symmetry and direction
Related and duplicate are symmetric for presentation: the canonical key sorts versioned endpoints and shows one connection. Stored orientations and their supporting passage IDs remain intact. Supports and contradicts retain source/target direction and arrows; their reversed orientations are not blindly collapsed.

## Evidence inspection
The inspector's Why linked action shows actual source and target passages, headings/pages when available and pinned versions. Links expire from current presentation when either endpoint advances or its evidence cannot be validated. Updating a target can schedule related source organization for reevaluation.

## Quality boundary
Accepted links over a small supplied neighbor set are a diagnostic, not production recall. Use separately labeled pairs to measure precision/recall and distinguish discovery failure, candidate-generation failure and Jev decision failure. Manual document moves do not imply that original files were edited or that model link decisions became human-authored evidence.

## Source references
- `app/jev.py`
- `app/relationships.py`
- `app/search.py`
- `app/ui.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
