# Symbiknow / Interface / PDF first page rendering pipeline and failure states

Repository implementation guide. Snapshot: 17 October 2026.

## Derived renderer
The thumbnail route requires an explicit version and validates the document ID. A cache entry uses document ID plus version. For PDFs, the route reads the exact original, applies a thirty-two-MiB input cap and invokes a separate PDFium subprocess with a twenty-second timeout.

## Image production
PDFium opens the first page, validates positive page bounds, renders a bounded scale with forms drawing disabled and converts to RGB. The image is thumbnailed to 264×340 and encoded as JPEG quality 85. Handles are closed, and the route writes a derived thumbnail cache atomically under its write lock.

## Reader contract
Cards display the first-page thumbnail. The inspector and Quick Look use Previous/Next controls and a page count for bounded page images. The same isolated PDFium process renders the requested page at up to 1,400 pixels per edge, with the twenty-second timeout and thirty-two-MiB source cap. Reader caches include document ID, version and page. Open PDF / Download PDF retains the full exact original; the reader does not embed a native PDF iframe. Image/subprocess failure produces an explicit unavailable message; the original remains downloadable.

## Cache and integrity
The HTTP thumbnail is privately cached, while original responses use no-store. A thumbnail success or failure does not create a content version, rewrite the PDF or establish OCR correctness. Backend tests verify actual thumbnail output and original bytes separately.

## Runtime limit
The application removes the blank native-iframe path. Target native-desktop viewer qualification and full-document inline PDF requirements remain separate decisions.

## Shared bounded preview owner

Thumbnail and page jobs share `PreviewJobs`: two worker threads, ten total in-flight identities (two running plus eight waiting), and identical requests share one Future. Canceling a waiter does not release a running renderer slot. The default disk budget is 256 MiB with a seven-day age limit; version/page keys and deletion checks remain required. Shutdown drains running work before releasing ownership. Originals use verified disk leases rather than repeated whole-file byte materialization.

## Source references
- `app/pdf_thumbnail.py`
- `app/ui.py`
- `frontend/src/components/DocumentInspector.tsx`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
