# Symbiknow / Operations / Quality corpus JSON schema and offline scoring

Repository implementation guide. Snapshot: 12 October 2026.

## Required provenance
The evaluation script requires corpus provenance with annotator and split. independent=true plus split=held_out is recorded as declared independence; the script cannot certify how the labels were produced. Known developer regressions should use an honest regression split.

## Answerability cases
Each case has id, question and documents. Each document supplies document_id, version, real evidence and expected_label. Recognized labels are direct, partial, related, unrelated and uncertain. Live cases must fit the application's eight-text-candidate budget; visual-only material is outside this text evaluation scope.

## Grouping cases
Each document also supplies filename, evidence and expected_cluster. Cluster IDs are arbitrary human membership labels. Pairwise grouping compares co-membership rather than exact folder-name spelling. Predicted Unfiled is absence of an assignment, not a shared topic.

## Commands
Use `scripts/evaluate-jev.py --corpus CORPUS.json --predictions PREDICTIONS.json --output REPORT.json` for saved decisions, or --live for explicit hosted calls. Seeds default to 0, 1 and 2 for shuffled runs.

## Outputs
Per-class support/precision/recall and confusion counts separate answer errors. Grouping reports pair precision/recall, singleton/Unfiled rates and shuffled co-membership agreement. This harness excludes full ingestion, OCR, neighbor discovery and capacity.

## Source references
- `scripts/evaluate-jev.py`
- `app/evaluation.py`
- `tests/test_evaluation.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
