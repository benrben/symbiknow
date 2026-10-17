# Symbiknow / Interface / Preview history GFM and PDF behavior

Repository implementation guide. Snapshot: 13 October 2026.
## Reader and original
The inspector provides Document, Versions and Connections, plus Evidence for search results. Each evidence activation resets the requested matched version and Evidence focus, including repeated clicks after viewing older versions. Quick Look uses the same preview policy. Selecting history pins actual version bytes and downloads. Historical Details does not invent today's folder/groups or a Pending organization state; it explicitly says organization was not recorded for that version.

## Markdown and HTML
Reader and cards share remark-gfm tables, task lists and code fences. Tables scroll within their own container rather than stretching the desktop. Selected supporting text can be highlighted without discarding table structure. Raw Markdown HTML and remote image/link loading are disabled.

HTML preview is a separate opaque sandboxed frame with DOMPurify filtering and restrictive content-security policy. Its original remains downloadable as an attachment; preview rendering never rewrites the original. Text originals larger than the inline two-MiB guard show an explicit download path.

## PDF and image
Images use their actual source or version-keyed thumbnail. PDF cards show page one. The reader and Quick Look offer Previous/Next page controls and a page count, using the existing isolated PDFium renderer. Open/Download actions retain the full exact original. A failed image preview produces an explicit unavailable state, not a permanent blank native-PDF iframe. Each inline page is a derived image; exact original downloads and version history remain independent of page rendering.

## Bounded cards
Cards lazy-load representative evidence and keep a bounded version-keyed memory cache. They do not mount original bodies or PDF viewers for every item, and content is not stored in localStorage. Exact originals/history are independent of every preview's success.

## Source references
- `frontend/src/components/DocumentInspector.tsx`
- `frontend/src/components/Markdown.tsx`
- `frontend/src/components/ContentCard.tsx`
- `app/ui.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
