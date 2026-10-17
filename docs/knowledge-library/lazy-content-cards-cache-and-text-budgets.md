# Symbiknow / Interface / Lazy content cards cache and text budgets

Repository implementation guide. Snapshot: 13 October 2026.

## Request boundary
ContentCard observes visibility with IntersectionObserver and a preload margin. It requests representative current-version evidence rather than downloading every original body. The UI card endpoint returns at most two evidence rows with each text truncated to 1,600 characters.

## Rendering boundary
Cards show at most 1,200 characters of a chosen text representation, with a real extracted heading when present. Markdown uses the shared safe GFM renderer. Image/PDF cards use version-keyed thumbnails rather than an iframe per item.

## Matched sentence context
Search preview selection stays within supplied evidence windows. It joins soft extraction wraps and uses sentence boundaries that preserve decimal versions such as rocfl 1.7.0. Query-focused excerpts retain the source subject and negative answer where possible. Compact Canvas quotation can show a literal prefix/suffix with an explicit omission marker; it never changes the accepted evidence role. The Evidence tab retains complete evaluated passages.

CSV previews show literal bounded cells; PDF cards show page one and supported images show original-derived thumbnails. Failure keeps Open/Download available. Appearance and view switching do not make provider calls or alter originals.

## Cache identity
The memory cache is keyed by document ID and version and bounded to two hundred entries. A content update uses a different cache key. Search cards prefer the current matched excerpt/evidence, avoiding an ordinary browse cache overwriting a search answer passage.

## Failure and cancellation
Abort signals prevent obsolete requests publishing into a new card. Missing/failed evidence offers an Open/Download path. No content text is stored in localStorage. A preview cache is not an original-byte recovery store.

## Scope limit
Lazy previews and bounded cards reduce a rendering cost. They do not prove browser/native memory for one hundred thousand originals, and they must preserve clear loaded-versus-scope counts when only a working subset is mounted.

## Source references
- `frontend/src/components/ContentCard.tsx`
- `app/ui.py`
- `app/organization.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
