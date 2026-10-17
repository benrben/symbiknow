# Symbiknow

One Python application for local agent file memory. Original bytes and independent
document histories live in an OCFL repository managed by **rocfl 1.7.0**, without
Git. LanceDB holds two derived tables. Docling converts and chunks supported files;
**EmbeddingGemma 2** embeds text and native images. Hosted **TypeSafe Jev** judges
evidence and selects logical folders, groups, and versioned relationships.

The MCP server exposes exactly **upload**, **download**, and **search**. Files travel
as base64 bytes through the official Python MCP SDK, including historical versions.
An upload can be stored successfully while indexing is pending or has failed.

## Setup

Requires macOS Apple Silicon or Linux, Python 3.12, `uv`, and a native rocfl binary.
The checked-in `uv.lock` pins the complete dependency graph. Model weights and
Docling OCR/layout assets download on first use; internet access is needed then.

```sh
uv sync --locked
sh scripts/install-rocfl.sh
```

The installer builds rocfl from its pinned upstream release with filesystem support.
It uses a workspace-local Rust toolchain and writes only `.tools/`. The upstream
macOS release binary is Intel-only and failed on this ARM machine without Rosetta.
If you already have a native **rocfl 1.7.0**, set `ROCFL_BIN` to its absolute path.
The application rejects other CLI versions because their command contract is untested.

The local `.env` exists and is ignored by `.gitignore`; set your hosted Jev token:

```dotenv
TYPESAFE_API_KEY=your_secret_token
```

Use `.env.example` for other settings. Do not commit `.env`. The server loads the
project's `.env` without overriding exported environment variables. Jev uses
`jev-1.13.0` by default; `TYPESAFE_DEFAULT_MODEL` can override it. Missing credentials
or a Jev outage leave ordinary retrieval and byte transfers available. Selected
text evidence is sent to the hosted Jev API when organization or evaluation runs.
Pixels are never sent for a claimed Jev image judgment.

```sh
uv run python scripts/check-runtime.py
uv run python -m app.server
```

The runtime check executes the real EmbeddingGemma 2 model on text and a PIL image,
then a live structured Jev judgment. It never substitutes another model. The model
checkpoint is `google/embeddinggemma-2` at revision
`2c791de4ddbe5cabd592cc93692f7acb67e52555`. The default runtime selects MPS on Apple
Silicon, CUDA when available, or CPU. MPS/CPU use float32; supported CUDA uses bf16.
The unused audio encoder is disabled. Default output is normalized 768-dimensional
vectors; optional 128/256/512 dimensions require rebuilding the derived index.

The PyTorch/MPS path was tested on an Apple M5 Pro with 48 GB RAM. The requested
M4 with 16 GB RAM target, MLX, and L4 CUDA hardware still require validation.

## Human UI and shared HTTP MCP

The refined UI includes a folder canvas, Files/Recent browsing, three search modes,
an independent Jev evaluation switch, version previews/downloads, and selective
organization rebuild with progress and retry. See [UI.md](UI.md) for behaviors,
API details, tests, screenshots and limitations.

Requires Node.js 22.12+ in addition to the Python/rocfl setup above.

```sh
npm --prefix frontend ci
sh scripts/dev.sh
```

Open http://127.0.0.1:5173 for hot reload. For one-command build and a single-port
server, run `sh scripts/web.sh` and open http://127.0.0.1:8765.

Agents using UI mode connect to `http://127.0.0.1:8765/mcp` through their Streamable
HTTP configuration. They must not start another stdio owner against the same data
directory. HTTP sessions and the browser share one worker and exactly three tools.
Stop the web server before using the legacy stdio alternative below.

## Alternative: connect a stdio MCP agent

Use a long-lived stdio session. Substitute your actual absolute project path:

```json
{
  "mcpServers": {
    "symbiknow": {
      "command": "/Users/benreich/Projects/symbiknow/.venv/bin/python",
      "args": ["-m", "app.server"],
      "cwd": "/Users/benreich/Projects/symbiknow",
      "env": {
        "SYMBIKNOW_DATA_DIR": "/Users/benreich/Projects/symbiknow/data"
      }
    }
  }
}
```

Only one server may own a data directory. Each MCP client host has its own message
limits; SDK interoperability does not establish the limits of every agent host.
Base64 is present in protocol responses. The CLI suppresses it in printed download
summaries, but the host must control what enters the agent's context.

MCP search defaults to `detail="compact"`: a response-wide 32 KiB UTF-8 structured
JSON budget, short version-pinned excerpts, validated support/conflict references,
and explicit omission counts. Use `detail="full"` for evaluated text windows and
raw Jev probabilities. The browser requests full results for its inspector.
Neither projection represents the entire original: use version-pinned `download`.
Compact pages preserve the requested result window (at most 100 matches). Repeat
the same arguments with `page.continuation` to fetch the next page without new
retrieval or evaluation. Cursors expire after five minutes; changed index,
organization, authoritative heads, passages or links require restarting the search.
The separate complete SDK-result budget is 128 KiB, not an HTTP wire-size guarantee.

Jev records its raw Choice separately from application policy. Choice confidence
measures concentration across options, not the probability an evidence fact is true.
“Contains supporting evidence · Coverage not established” retains validated facts
without claiming a complete answer. Possible conflicts require verification;
“No accepted conflict” does not prove there is no contradiction. Premise corrections
are separate from disagreement between applicable sources. Evaluation covers at
most eight candidates, with one additional bounded comparison of up to two
applicable windows per candidate; unavailable comparisons remain explicit.
Search-specific
support, applicability and conflict thresholds do not change organization/link gates.

Search validates OCFL heads during candidate retrieval and again after provider
work. Final freshness and citation resolution share the cross-process storage lock
used by supported adapter writers. Do not mutate this repository through an
unmanaged rocfl process while the app is running. Provider calls hold no storage,
index or global judgment-cache lock. Request metrics report durations and head-read
counts without queries, document text or credentials.

## Sample tool arguments

Single and bulk operations both use a `files` array. Preserve the UUID request ID
when retrying an upload. Supply `document_id` to update a document; otherwise the
request ID determines a stable new identity. Identical files with different upload
request IDs retain independent identities. Identical updates still get new versions.

```json
{
  "name": "upload",
  "arguments": {
    "files": [{
      "filename": "notes.txt",
      "mime_type": "text/plain",
      "source": "/notes/notes.txt",
      "request_id": "6be4ba0b-38ac-4b51-9ec1-1d4f1896857d",
      "content_base64": "SGVsbG8gU3ltYmlrbm93Cg=="
    }]
  }
}
```

Updates may include `expected_version: "v1"` for optimistic concurrency. A replay
of a committed request returns the original version even after later updates.
Reusing that request ID with different bytes or metadata is an error.

```json
{"name":"download","arguments":{"files":[{"document_id":"DOCUMENT_ID","version":"v1"}]}}
```

Downloads include actual `content_base64`, original filename/MIME/source, the pinned
version, whole-file SHA-256, range offset, returned size, and EOF. Continue ranges
using that returned version. Use `history: true` on a download item to list all
version metadata along with the requested byte range.

```json
{"name":"search","arguments":{"query":"What did we decide?","mode":"hybrid","limit":8,"evaluate":true}}
```

Modes are `semantic`, `keyword`, `hybrid`, and `answer` (hybrid with Jev evaluation).
`answer` and `evaluate=true` return accepted answer evidence only. If nothing is supported,
`matches` is empty and `answer.status` explains whether no answer was established,
more context is needed, or checking is unavailable. Partial answers and premise corrections
remain explicit. Use `evaluate=false` to browse related files without answer checking.
The evaluation budget and candidate counts are reported; an empty answer list does not
assert that the entire library has no answer. See `docs/mcp-reference.md` for the contract.

Optional `folder` and `group` filters use logical metadata. Results identify the
exact document and OCFL version, evidence IDs, passage/page provenance, score kind,
and relevance explanation. Jev adds direct/partial/related/unrelated/uncertain judgments and
IDs of supplied supporting passages. Pure visual matches have no text answerability
claim. Jev may decline to assign a relationship.

## File transfer client

```sh
uv run python client.py upload notes.txt photo.png
uv run python client.py upload notes.txt --document-id DOCUMENT_ID --expected-version v1
uv run python client.py download DOCUMENT_ID --version v1 --output-dir downloads
uv run python client.py search "What did we decide?" --evaluate
```

The client starts its own stdio server, so stop an existing server using the same
data directory first. Prefer an agent's long-lived connection for background
indexing. For a transfer-only session use `client.py --storage-only upload ...`.
Use `--data-dir PATH` before the command for an isolated repository.

For retries across CLI invocations, pass one `--request-id UUID` per input file.
Without explicit IDs, a fresh CLI invocation is a fresh upload.

The transfer client batches at most two small files per call and uses 256 KiB raw
chunks for larger files, with SHA-256 verification and version-pinned downloads.
It preserves filenames in metadata and prefixes downloaded filenames with document
and version IDs to avoid collisions. It refuses to overwrite an existing output.
Partial upload state is kept in `data/temp`; repeat chunks with the same request ID,
offset, total size, and whole-file SHA-256 to resume. The default maximum file size
is 256 MiB. Completed transfer receipts persist for idempotence.

## Processing and recovery

Original bytes are committed before conversion/model initialization. The single
ingestion worker reconciles committed OCFL heads with LanceDB metadata after startup
and when uploads arrive. Indexing retries replace derived chunks, never create file
versions. Publication follows complete chunk writes. Search verifies hits against
current OCFL heads and excludes old content while a newer version is pending.

Search reports worker activity, queued upload items, and known retry counts,
rather than a complete stored-file count. Download reports the requested version's
indexing status. Superseded relationship endpoints are omitted; affected linked
sources are queued for fresh organization when an update is indexed.

Markdown, UTF-8 TXT, HTML, PDFs, and common image formats are supported. Docling's
existing structural/token chunker preserves headings and page provenance. PDFs
include extracted text and page-image representations; images include native
visual embeddings and available OCR. Unsupported formats remain downloadable with
an explicit `unsupported` indexing status. Encrypted PDFs, unavailable model/OCR
assets, malformed input, and extraction errors keep originals and report failures.

Jev organization is metadata, never a filesystem move. Full rebuilds prepare shared
subject folders from headings, named projects and shared prose topics, then rank memberships with stored
chunk embeddings and Jev. Subject paths provide parent/child navigation and descendant
filters. Links preserve both endpoint versions
and supplied evidence IDs. Judgments are validated against the offered choices and
passages. Exact duplicate links are verified with SHA-256, independently of semantic
neighbor rank; model passage similarity alone cannot label different files duplicates.
Duplicate judgments never merge document identities.
Candidate names exclude document types and test boilerplate. Project scope is retained
for new topics as well as existing folders. Symmetric related/duplicate links display
once per document/version pair; support and contradiction directions remain distinct.

Use a folder's action menu to delete its organization and move its documents to
Unfiled, preserving their history. Use Document actions → Delete document to
permanently delete a document and all versions after confirmation. A latest-version
guard protects newer uploads from stale selections. Interrupted purges recover at
startup; deleted identities cannot be restored by replaying an old upload request.

## Validate and back up

```sh
uv run pytest -q
uv run ruff check app client.py tests scripts
```

Tests exercise real rocfl and LanceDB, actual SDK stdio transfers, historical byte
integrity, conflicts/replays, parent-process interruption, indexing recovery, stale
hit rejection, formats/provenance, and Jev SDK response validation. Unit retrieval
tests use an explicitly labeled injected test embedder; production never uses it.
Live model/provider checks are separate from reproducible offline tests.

Live checks and the repeatable synthetic benchmark:

```sh
uv run python scripts/check-mcp.py
uv run python scripts/benchmark.py --output benchmark.json
```

After a large indexing batch, stop the daemon and run LanceDB's built-in maintenance:

```sh
uv run python -c 'from app.search import maintain_index; print(maintain_index("data"))'
```

Use your actual data-directory path. This creates scalar indexes, a cosine IVF-SQ
index when at least 1,024 chunks exist, and compacts derived tables. New fragments
remain searchable before maintenance. ANN trades exact ranking for speed and needs
corpus quality measurements; the five-file benchmark uses exact vector scanning.

Stop the server before backing up. Copy the **complete data directory** (including
`files`, `index`, and `temp`), then restore to a separate directory and compare old
and current download hashes. OCFL originals are authoritative; the search index can
be rebuilt by removing only the derived `index` directory while stopped and restarting.
Never remove or rewrite the OCFL files/inventories manually.

rocfl update commits rename the new version directory then copy root inventory
files. A killed Python parent leaves the child rocfl process holding the storage
lock so it can finish, which is tested. Killing rocfl itself, power loss, or disk
failure during that upstream commit can still require OCFL validation and recovery
from backup. No stronger crash durability guarantee is claimed.

## Measurements and limits

See `VALIDATION.md` for the actual host, checks, and measured workload. This is a
single-computer implementation, without microservices, an external graph store,
custom search engines, or custom file versioning. A 100,000-document corpus, 50 real
labeled questions, 16 GB peak-memory budget, and L4 performance are **not validated**
by small functional tests. Corpus chunk counts, image dimensions, OCR complexity,
and historical byte volumes determine capacity. Startup head reconciliation is a
scan, and historical download ranges currently read/verify the whole file per range.

## Verified upstream contracts

- [rocfl 1.7.0](https://github.com/pwinckles/rocfl/releases/tag/v1.7.0)
- [LanceDB hybrid search](https://docs.lancedb.com/search/hybrid-search)
- [Docling chunking](https://docling-project.github.io/docling/concepts/chunking/)
- [Google EmbeddingGemma 2 model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2)
- [EmbeddingGemma 2 developer guide](https://developers.googleblog.com/embeddinggemma-2-the-developer-guide/)
- [TypeSafe official Python SDK](https://docs.typesafe.ai/sdk/python)
- [TypeSafe model limitations](https://docs.typesafe.ai/models)
- [Official MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)

Memory ownership, idle unloading, transfer limits and the optional pinned MLX
runtime are documented in [memory runtime controls](docs/memory-runtime.md).
