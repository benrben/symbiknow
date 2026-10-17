# Symbiknow MCP protocol

Symbiknow exposes exactly three MCP tools: `upload`, `download` and `search`. File transfers carry real bytes as base64 through the official MCP SDK. Use the running HTTP endpoint when the browser app already owns the library.

Symbiknow / Development / MCP protocol

## Connect to the running app

The shared Streamable HTTP endpoint is `http://127.0.0.1:8765/mcp`. The repository's installed MCP SDK supports `Client("http://127.0.0.1:8765/mcp")`. Discover the tool schemas with `list_tools()` before calling tools.

`client.py` provides reusable `call`, `upload_files` and `download_files` helpers. Its command-line entry point starts a stdio server; use its helper functions with an HTTP client session when the web server is already running. Starting another stdio owner against the same data directory is a conflict.

## Upload

The required outer argument is `files`, containing 1–32 items. Each file supplies `filename` and `content_base64`. Optional fields include `mime_type`, `source`, `request_id`, `document_id` and `expected_version`.

```json
{"files":[{"filename":"project-notes.md","mime_type":"text/markdown","request_id":"0e2f8790-d78a-4cc3-9aba-d54539141d01","content_base64":"IyBQcm9qZWN0IG5vdGVzCg=="}]}
```

A new upload request creates a new independent document. To update an existing document, provide its `document_id` and the latest `expected_version`. Matching filenames do not select an overwrite target. A replay of a committed UUID request returns the original committed result rather than another version. Reusing the request ID with different bytes or metadata is a conflict.

Each item returns its own stored success or error, document ID, version, SHA-256 and indexing state. A stored file may still be pending, failed, empty or unsupported for indexing. Check the per-file result rather than only the outer MCP response.

For a larger file, send sequential chunks with `offset`, `total_size`, a lowercase whole-file `sha256` and `final: true` on the final chunk. Preserve the request ID and metadata across retries. The default raw chunk limit is 262,144 bytes and the default whole-file limit is 268,435,456 bytes. The repository helper batches at most two small files per request to limit message size.

## Download

Each item requires `document_id`; `version`, `offset`, `length`, `history` and `include_versions` are optional.

```json
{"files":[{"document_id":"DOCUMENT_ID","version":"v1","offset":0,"length":262144,"history":true}]}
```

The response includes original filename, MIME, source, whole-file hash and size, pinned version, requested offset, returned byte count, EOF and base64 bytes. `history: true` also returns version metadata. Pin the first returned version for later ranges and verify the reconstructed whole-file SHA-256. The transfer helper checks the hash and refuses to overwrite an existing download destination.

A length of one byte can retrieve the metadata and history without transferring a large original. It is still a ranged download, not a substitute for verifying the complete file when byte integrity matters.

## Search

`query` is required. `mode` is `semantic`, `keyword`, `hybrid` or `answer`; `answer` means hybrid retrieval with Jev evaluation. Optional arguments are `limit` (1–100), `folder`, `group` and `evaluate`.

```json
{"query":"How are original versions preserved?","mode":"hybrid","limit":8,"evaluate":true,"folder":"Symbiknow"}
```

Results identify document and version, evidence IDs and provenance, retrieval score basis, logical organization and relevance explanations. Folder and group scopes intersect; a parent folder includes descendants at path boundaries.

Jev evaluates at most eight answerability candidates per search. With `mode="answer"` or `evaluate=true`, `matches` contains only accepted complete/partial answers or applicable premise corrections. Related, uncertain and unchecked candidates are not answer results. For ordinary matching files, use semantic/keyword/hybrid with `evaluate=false`.

The `answer` object reports `status`, `candidate_count`, `evaluated_count`, `not_evaluated_count`, `answer_count`, `complete_count`, `partial_count`, `correction_count` and `needs_context_count`. Status is `answered`, `partial`, `corrected_premise`, `needs_context`, `no_answer_in_evaluated_candidates`, `no_candidates`, `not_evaluated`, `unavailable`, or `not_requested`. An empty answer list describes the evaluated candidate windows, not proof that no answer exists anywhere in the library. A provider outage is explicitly unavailable; it is never converted into a no-answer judgment. Accepted cached answers can remain available during a partial outage.

Selected supporting passages must be real supplied IDs. Coverage uses an independent all-parts check; intermediate confidence can produce a supported partial answer, never an invented complete one. Passage applicability checks the requested checkpoint/time independently of document age. Independent document calls run with at most four simultaneous provider requests across searches, then cross-document consistency is checked. Provider failure leaves ordinary retrieval usable. Visual-only matches do not claim a text answer. Keywords are useful for exact identifiers and checking whether a freshly imported document has entered the index.

## Human routes

Browsing, previews, rebuilds and delete confirmations are human UI routes rather than additional MCP tools. Keep the advertised MCP contract at three tools. Do not edit OCFL inventories or LanceDB rows to imitate an MCP upload.

## Source references

Tool functions and validation: `app/server.py`. Transfer implementation: `client.py`. HTTP sharing and owner-lifecycle regression: `tests/test_http_runtime.py`. Transfer/recovery regression: `tests/test_mcp.py`.

## Compact continuation (review 9)

`detail` defaults to `compact`; `full` retains diagnostic data for all eligible matches in the requested window. `limit` remains 1–100 and means the requested retrieval window, not the page size or a library-wide relevant-document count. Compact `page.window_count` counts eligible results within that bounded candidate window. Retrieval still examines at most `min(limit * 8, 800)` chunks. Equal document scores use document ID as the tie-breaker.

Each compact text result keeps a useful UTF-8 excerpt (normally up to 384 bytes), identity/version, retrieval/decision fields and bounded evidence records. Native visual results have an explicit visual basis and empty text. Citation IDs in compact role lists always have corresponding evidence records. For pathological citation counts, `match.omissions.citations` explicitly counts omitted roles; `detail=full` provides all diagnostics. Compact excerpts may be shorter than the evaluated windows and are never presented as complete originals.

Passage selection preserves up to three ranked windows per returned document and adds bounded structural/adjacent context, at most six windows total. For numbered text chunks, one context slot prioritizes the first passage when it is not already ranked: this supplies introductory subject/mechanism context even when the highest-ranked passages occur later. It uses the existing exact identity/version passage batch, without another search, greater candidate depth, additional authoritative head reads or a larger provider budget. This is an inclusion safeguard rather than a guarantee that every answer-bearing passage is found; provider judgment still decides applicability and support.

`page` reports `offset`, `returned_count`, `window_count`, `has_more` and `continuation`. Pass the token as the optional **existing search** argument `continuation`, repeating the identical query, filters, mode, limit, evaluate and detail arguments. Pages reuse the original order and judgments. Answer pages contain only accepted answers; `answer.not_evaluated_count` explicitly reports candidates outside the eight-document evaluation budget. Continuation does not perform retrieval, embeddings or provider calls.

```json
{"query":"Symbiknow","folder":"Symbiknow","mode":"keyword","limit":100,"detail":"compact","continuation":"TOKEN_FROM_PAGE"}
```

Tokens expire after five minutes, or earlier after process restart/eviction. At most 16 windows and 32 MiB of retained diagnostic data are kept in memory. This is a restart-on-change contract, not a frozen library snapshot: index/organization revisions invalidate tokens, and **every document and relationship in the retained bounded window** is checked again against authoritative OCFL heads and current evidence before each continuation is published. This also detects an OCFL commit before derived revisions are updated. Changed scopes, judgments, links or windows require a fresh search. Invalid, mismatched and expired tokens return explicit restart errors. No-progress pages never issue another token.

Continuation refresh operates on a copy and compares its complete validated entries with the retained original window. This detects same-head extracted-text changes and relationship-target update/deletion before derived revision publication; a rejected refresh does not replace the comparison baseline.

A first-page retrieval interrupted by concurrent ingestion or organization retries once, before Jev evaluation starts. A second snapshot change returns an actionable MCP error asking the caller to retry when the library settles. It never returns a mixed snapshot or loops indefinitely. Expected search-validation and continuation errors retain their explanation through the SDK's public `ToolError` contract. Unexpected exceptions remain sanitized.

The compact structured JSON budget is 32 KiB, including page metadata and request metrics. The separate tested complete SDK `CallToolResult` budget is 128 KiB, including both JSON text and `structuredContent`. These are UTF-8 serialization budgets, not HTTP envelope or token-count guarantees. Normal pages budget whole useful entries before dropping entries; they do not erase every excerpt. An entry that cannot fit after bounded diagnostic truncation returns instructions to request full detail or a smaller limit.

## Evidence decisions

Raw `model_label`, Choice concentration and passage judgments are separate from `policy_label`, `coverage` and accepted citations. A negative answer is usable support. Premise correction requires that the question assumes a fact and applicable evidence explicitly denies it; silence does not qualify. `conflicting_chunk_ids` remains the compatible premise-correction field, with additive `premise_correction_status`. Actual inconsistency uses `evidence_disagreement` and document-local `disagreement_chunk_ids`. When multiple evaluated documents supply applicable evidence, one additional bounded comparison checks up to two windows per document. `evaluation.cross_document_assessment` reports its raw probabilities, compared IDs, status and scope; it establishes no library-wide agreement. `disagreement_scope` distinguishes the comparison performed. Accepted and possible local disagreement references retain corresponding compact evidence records or explicit omission counts.

Provider evaluation uses at most eight document-scoped requests per search and six text windows per document, plus at most one cross-document comparison, with a shared four-call concurrency bound. Provider slots, embedding work and network calls never hold the judgment cache or publication locks. Cached judgments include document/evidence/version, filename context, model, prompt, policy and all semantic thresholds/context criteria; the comparison cache also binds its complete compared window set and window bound. Provider failures are not cached. Continuation reuses the same evaluated window rather than multiplying the eight-document budget. Final publication verifies every compared current window: if a counterpart head, scope or passage changed, dependent decisions become `not_evaluated` with reason `disagreement_evidence_changed`, and the comparison reports `unavailable` / `evidence_changed`. The retrieved current text remains available for a fresh search.


Hybrid ranking retains rank fusion for Latin-script queries. Cross-script questions use LanceDB’s built-in weighted combination (0.7 semantic, 0.3 lexical), reducing the effect of a shared Latin project name on a question written in another script. This is tested on a small local corpus, not a general multilingual accuracy guarantee.

Organization uses a separate bounded selection of owner-bearing passages from up to 128 sampled source chunks; topics and links retain their smaller evidence budgets. Canonical aliases are deduplicated before choosing an owner, generic/numbered labels are filtered, and lowercase project headings are eligible hypotheses. Filename and import source may corroborate substantive project context but never force assignment. Manual placement and original file versions remain separate from automatic metadata.
