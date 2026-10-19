# Symbiknow / Search / Retrieval modes ranking and scopes

Repository implementation guide. Snapshot: 19 October 2026.
## Modes
keyword uses LanceDB full-text search over extracted text. semantic embeds the query with the configured local model and searches compatible stored vectors using cosine distance. hybrid combines query text and the query vector. The public answer alias uses hybrid retrieval with Jev answerability enabled.

## Filters and current versions
Optional folder and group scopes intersect. A parent folder includes descendants only at path boundaries, so similarly prefixed names are not accidentally merged. Only active chunks from a document with a matching indexed/current version are eligible. Retrieval also checks the committed OCFL head, protecting against interruption between a content commit and pending registration.

## Result construction
The retrieval layer requests a bounded candidate pool, consolidates passages per document and reports real document/version IDs, evidence, score kind and a relevance explanation. Score values from different modes are not interchangeable confidence or accuracy percentages. The human search currently requests at most forty candidate documents; Jev evaluates at most eight text-bearing candidates.

## Choosing a search
Exact identifiers and phrases are good keyword probes for newly indexed files. Semantic retrieval helps with differently phrased concepts. Hybrid is the normal UI default. Test scope and current processing state before interpreting a miss as a semantic failure.

A successful small-corpus search is not a recall benchmark for 100,000 documents. Performance and answerability need separate measurements with known relevant documents and independent labels.

## Current ranking and continuation

Latin-script hybrid retrieval uses rank fusion; cross-script queries use a 0.7 semantic/0.3 lexical weighted combination. This is covered by a small local regression corpus, not general multilingual qualification. MCP compact results page a bounded retrieval window (`limit` up to 100), with 32-KiB structured JSON and five-minute continuation tokens. Continue with identical arguments; content/organization changes require restarting. `detail=full` exposes supplied diagnostic windows, not the complete original. See `docs/mcp-reference.md`.

## Result metadata and UI ordering
Each current search match carries the saved-version timestamp as `created_at`, including full and compact MCP projection. The UI labels it Modified. Search initially retains retrieval order; Name, Type and Modified sorting only rearranges loaded results, with an independent direction and no new model call. A sort is not a larger retrieval window or evidence-quality decision. Missing dates remain last in either direction.

## Source references
- `app/search.py`
- `app/server.py`
- `docs/mcp-reference.md`
- `tests/test_search.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
