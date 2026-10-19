# Symbiknow / Organization / OCR aliases and project identity policy

Repository implementation guide. Snapshot: 17 October 2026.

## Established names before aliases
ProjectNames keeps exact case-folded lookup and maximum name length. Explicit project/subject headings establish scope. Non-OCR evidence and existing suitable project paths can establish names for uncertain OCR recognition.

## Limited normalization
For OCR material, a dangling possessive s can be removed only when the base matches a known identity. Exact casing can resolve to the established spelling. The code deliberately does not fuzzy-merge arbitrary names: a company whose real name ends in S must remain distinct.

## Ordinary prose and cross references
Scope recognition examines substantive sentence subjects and named headings, excluding generic workflow/document words. Later incidental comparisons should not override the main document owner. Unknown scope does not grant permission to file content in an unrelated project's folder.

## Failure investigation
Preserve the original OCR text and provenance when diagnosing an alias. Compare the raw heading, trusted catalog and selected candidate path. A filename-based guess or fuzzy string similarity is insufficient proof that two names identify the same project.

## Evaluation
The existing tests include renamed entities, unfamiliar names and OCR variants. An independent multilingual/OCR corpus is still required to quantify recognition precision and cross-project filing errors; known regression examples are not broad identity benchmarks.

## Canonical owner hypotheses

Owner-bearing evidence is sampled from up to 128 source chunks, then bounded separately from topic/link evidence. Canonical aliases are deduplicated before owner choice; generic or numbered headings are filtered while lowercase project headings remain eligible hypotheses. Filename/source can corroborate substantive context and never force ownership. A canonical project roster under `temp/canonical-projects.json` keeps stable identity separate from display aliases and folder placement.

## Source references
- `app/organization.py`
- `tests/test_organization.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
