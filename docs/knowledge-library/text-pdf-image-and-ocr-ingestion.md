# Symbiknow / Search / Text PDF image and OCR ingestion

Repository implementation guide. Snapshot: 12 October 2026.
## Supported content
The indexing predicate accepts plain text, Markdown, HTML/XHTML, PDF and common image types including PNG, JPEG, WebP, GIF, BMP and TIFF, with corresponding recognized extensions. Unsupported originals remain stored and downloadable.

## Text structure
Docling conversion preserves document structure. HybridChunker uses the embedding tokenizer and a 512-token chunking bound unless a supplied test tokenizer replaces it. Extracted evidence includes contextualized text and structural/page provenance. Plain-text content is wrapped into a Docling document before chunking.

## Visual content
PDF conversion requests page images and textual extraction. Native images preserve visual representations independently from available OCR text. Multi-frame image inputs are indexed by frame while their compressed original remains intact. An OCR failure for an image can leave its native visual representation searchable.

Conversion has configured timeout, page and size boundaries. Partial conversion produces a warning; no-evidence extraction is empty rather than an endless processing request. Ingest validates original SHA-256 before publishing vectors.

## Separate thumbnail path
The browser's PDF first-page thumbnail is a bounded derived JPEG generated through the existing PDFium dependency in a subprocess. It is a preview aid, not reindexed original content. A thumbnail failure leaves an explicit unavailable state and Open/Download actions. Full original PDF bytes remain available independently of OCR and thumbnail success.

## Source references
- `app/ingest.py`
- `app/embeddings.py`
- `app/pdf_thumbnail.py`
- `tests/test_ingest.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
