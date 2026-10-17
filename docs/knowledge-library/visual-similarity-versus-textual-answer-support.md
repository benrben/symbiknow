# Symbiknow / Search / Visual similarity versus textual answer support

Repository implementation guide. Snapshot: 12 October 2026.

## Different representation bases
Native visual chunks have a vector and page/frame provenance but no textual answer passage. OCR/text chunks have actual extracted text and provenance. An image can have both forms, or remain visually searchable when OCR fails.

## Retrieval and judgment
Semantic retrieval can return visually related content without a text quotation. The UI distinguishes Visual match / Not checked. Jev's textual answerability input filters out native visual-only rows; textless candidates cannot establish a direct or partial answer.

An OCR-derived answer may be checked over its text while disclosing OCR evidence. That does not guarantee perfect transcription, entity recognition or page-wide understanding. The evidence ID and original version remain the reproducibility boundary.

## Verification example
The runtime probe embeds colored squares and asks a visual query, then compares red versus blue ranking. This is a narrow native-image diagnostic. It is not a mixed-PDF/image recall benchmark or proof that arbitrary screenshot text can be answered without OCR.

## User recovery
If the visual result looks relevant but has no text support, open/download the original and inspect it. Do not turn similarity score into an answer confidence or fabricate a caption as if it were extracted source text.

## Source references
- `app/ingest.py`
- `app/search.py`
- `app/jev.py`
- `frontend/src/components/FileList.tsx`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
