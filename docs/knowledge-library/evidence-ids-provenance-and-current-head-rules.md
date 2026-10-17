# Symbiknow / Search / Evidence IDs provenance and current head rules

Repository implementation guide. Snapshot: 12 October 2026.
## Evidence is version-bound
Text chunks use IDs containing document_id, version and a text-chunk suffix. Visual chunks use a visual suffix. Returned evidence preserves the stored ID, text when available, basis and provenance. Page/item provenance and structural headings come from extraction, not invented display labels.

## Three kinds of material
Text evidence can support a text answer. OCR evidence is textual but must disclose its OCR origin. Native visual evidence supplies image similarity without a textual claim. An image vector alone must not become an Answers your question badge.

## Supporting passages
Jev can select only supplied evidence IDs. A direct or partial answer without a real selected supporting passage is downgraded to uncertain. The inspector can display selected passages; current search verdicts are not shown on a historical version merely because the document ID matches.

## Link evidence
A stored relationship pins source_version, target version and source/target chunk IDs. Why linked fetches the matching endpoint passages. If either endpoint has advanced or the required evidence is no longer valid, the relationship is excluded from current presentation.

## Preview versus citation
Canvas and grid excerpts are bounded representations for browsing. They are not full original files or independent proof of an answer. Download the exact pinned original for byte-level verification, and use versioned passages for an explanation that another developer can reproduce.

## Source references
- `app/search.py`
- `app/ingest.py`
- `app/ui.py`
- `app/jev.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
