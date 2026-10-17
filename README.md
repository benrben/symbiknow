# Symbiknow

**A local knowledge library for you and your AI agents.**

Keep original files and their version history, search text and images in English
or Hebrew, and inspect the evidence behind each result. A browser interface and
three MCP tools share one Python application and one library.

[Quick start](#quick-start) · [Connect an agent](#connect-an-agent) ·
[Documentation](#documentation) · [Measured performance](#measured-performance) ·
[Report an issue](https://github.com/benrben/symbiknow/issues)

![Symbiknow's light-theme library canvas, showing documents organized into nested subject folders](<docs/media/Symbiknow library canvas screenshot.png>)

## What you can do

- **Find files by meaning or exact words.** Semantic, keyword and hybrid search
  work with English/Hebrew text and native image embeddings.
- **Read the supporting evidence.** Results identify the document, version,
  passage or PDF page. Optional Jev checks distinguish supported answers,
  partial evidence and uncertainty.
- **Keep independent file histories.** Updates create a new version of the same
  document. Downloads preserve the original bytes and verify SHA-256 integrity.
- **Browse an organized library.** Use Files, Cards or Canvas, nested folders,
  related documents, PDF previews and version history.
- **Connect agents through MCP.** `upload`, `download` and `search` support
  resumable transfers, upload retries and version-pinned reads.
- **Control resource use.** PyTorch INT8 text weights, on-demand vision, idle
  unloading, bounded OCR child processes and streamed transfers reduce retention
  and active workload peaks.

Embeddings and storage run locally. **Jev organization and answer checking send
selected text evidence to the hosted TypeSafe API.** They are optional; ordinary
retrieval and file transfers remain available without a Jev token. See
[privacy and data ownership](#privacy-and-data-ownership).

## Quick start

### Requirements

| Requirement | Details |
| --- | --- |
| Operating system | Apple Silicon macOS is the tested INT8 platform. Linux/CPU and CUDA use the unquantized fallback. |
| Python | Python 3.12 tested; install dependencies with [uv](https://docs.astral.sh/uv/). |
| Frontend | Node.js 22.12+ and npm. |
| Original-file storage | Native **rocfl 1.7.0**, installed by the script below or supplied through `ROCFL_BIN`. |
| Model assets | Internet access for the first embedding and OCR/layout model downloads; access to the pinned Google checkpoint. |
| Optional evaluation | A [TypeSafe token](https://console.typesafe.ai) for Jev organization and answer checking. |

### 1. Install

```sh
git clone https://github.com/benrben/symbiknow.git
cd symbiknow
uv sync --locked --python 3.12
sh scripts/install-rocfl.sh
```

The rocfl installer builds the pinned filesystem-only release natively. Its Rust
build cache defaults to `~/.cache/symbiknow/rocfl-build`; the installed binary goes
in `.tools/native/bin`. To use an existing native rocfl 1.7.0 instead, set
`ROCFL_BIN` to its absolute path and skip the installer.

### 2. Configure

For a **new checkout**, create the local configuration:

```sh
cp .env.example .env
```

Keep an existing `.env` when upgrading. The example selects the tested Apple
Silicon configuration:

```dotenv
SYMBIKNOW_EMBEDDING_RUNTIME=torch
SYMBIKNOW_TORCH_QUANTIZATION=int8
```

**On CPU or CUDA, set `SYMBIKNOW_TORCH_QUANTIZATION=none` before the first run.**
INT8 execution is currently supported on MPS. The unquantized fallback uses
float32 on CPU/MPS and bfloat16 on supported CUDA devices; CUDA hardware was not
available for this release's validation.

To enable Jev, add your token to `.env`:

```dotenv
TYPESAFE_API_KEY=your_secret_token
```

`.env`, library data and downloaded models are ignored by Git. Exported environment
variables take precedence over `.env`. See [.env.example](.env.example) for limits
and [runtime controls](docs/memory-runtime.md) for precision and lifecycle settings.

> **Existing library?** Preserve its runtime settings. Index manifests guard the
> model revision, precision, dimensions and preprocessing. A precision change
> requires explicit compatibility validation or a separately rebuilt derived
> index. Do not delete a manifest to bypass the check.

### 3. Start the app

```sh
sh scripts/web.sh
```

Open **[http://127.0.0.1:8765](http://127.0.0.1:8765)**. The script installs the
locked frontend dependencies, builds the UI and starts the shared server. First
indexing or search may take longer while model assets download and initialize.

Import a text document, PDF or image, wait for its indexing status, then search.
Open a result to inspect its evidence and version history. Turn on **Check answers**
when you want Jev to evaluate retrieved text.

For later starts with the frontend already built:

```sh
uv run --locked python -m app.server --web
```

Stop with `Ctrl+C`. **Run one server per data directory.** The browser and HTTP
MCP clients share that server; a second stdio owner must use a separate library.

## Connect an agent

### Use the running web server

Configure your MCP client for **Streamable HTTP** at:

```text
http://127.0.0.1:8765/mcp
```

Connection configuration varies by client. Discover the advertised tool schemas
with `list_tools()` before calling them.

| Tool | Purpose | Integrity guarantees |
| --- | --- | --- |
| `upload` | Store one or more files; optionally update a document. | Stable request IDs make retries idempotent; `expected_version` guards updates. |
| `download` | Read current or historical original bytes. | Version-pinned ranges and whole-file SHA-256 verification. |
| `search` | Retrieve files, evidence and optional answer judgments. | Results identify exact versions and exclude stale current-file evidence. |

Example `search` arguments for browsing related files:

```json
{
  "query": "How do we recover an interrupted upload?",
  "mode": "hybrid",
  "limit": 8,
  "evaluate": false
}
```

Use `evaluate: true` or `mode: "answer"` for accepted answer evidence. An empty
answer list describes the evaluated candidates; it does not prove that the whole
library has no answer. Pure visual matches do not claim textual answer support.

[Full MCP reference](docs/mcp-reference.md): schemas, upload examples, chunked
transfers, expected versions, compact pagination and evidence decisions.

<details>
<summary>Alternative: a long-lived stdio connection</summary>

Stop the web server first if both connections would use the same library.
Replace `/absolute/path/to/symbiknow` with your checkout path:

```json
{
  "mcpServers": {
    "symbiknow": {
      "command": "/absolute/path/to/symbiknow/.venv/bin/python",
      "args": ["-m", "app.server"],
      "cwd": "/absolute/path/to/symbiknow",
      "env": {
        "SYMBIKNOW_DATA_DIR": "/absolute/path/to/symbiknow/data"
      }
    }
  }
}
```

Agent hosts have different message limits. File bytes are carried as base64 in
MCP responses; the host controls whether those payloads enter model context.

</details>

### Command-line transfers

The CLI starts its own stdio server. Stop an existing owner first, or select an
isolated library with `--data-dir PATH` before the subcommand.

```sh
uv run --locked python client.py upload notes.txt photo.png
uv run --locked python client.py upload notes.txt --document-id DOCUMENT_ID --expected-version v1
uv run --locked python client.py download DOCUMENT_ID --version v1 --output-dir downloads
uv run --locked python client.py search "What did we decide?" --evaluate
```

Keep the same `--request-id UUID` for retries across CLI invocations. Without an
explicit ID, a new invocation creates a new upload request. The client verifies
hashes, pins download versions and refuses to overwrite an existing output file.
The default file limit is **256 MiB**, with **256 KiB** raw transfer chunks.

## How it works

| Layer | Implementation |
| --- | --- |
| Original files and versions | [rocfl](https://github.com/pwinckles/rocfl) manages an OCFL repository. Each document has an independent identity and history. |
| Extraction and OCR | [Docling](https://docling-project.github.io/docling/) converts supported files and preserves structural/page evidence in bounded child processes. |
| Local embeddings | Pinned **EmbeddingGemma 2**, normalized **768-dimensional** vectors; PyTorch/TorchAO INT8 text weights and bfloat16 vision on the tested MPS setup. |
| Derived search index | [LanceDB](https://docs.lancedb.com/) stores document/chunk tables for vector, keyword and hybrid retrieval. |
| Evidence judgments and organization | [TypeSafe Jev](https://docs.typesafe.ai/sdk/python) evaluates supplied text and bounded choices; folders and relationships are logical metadata. |
| Interfaces | React browser UI and the official [Python MCP SDK](https://github.com/modelcontextprotocol/python-sdk), sharing one owner and ingestion worker. |

Storage commits happen **before** conversion and indexing. A successful upload
can therefore be pending or failed for search while its original remains safe to
download. Retries replace derived representations without creating extra file
versions. Publication and search check the current committed head.

Markdown, UTF-8 text, HTML, PDFs and common image formats are supported. PDFs use
extracted text and page images; images use native visual embeddings and available
OCR. Unsupported or failed extraction keeps originals downloadable with an explicit
indexing status. Transient indexing failures back off; permanent failures pause
until corrected or explicitly retried.

See [architecture](docs/architecture.md) and [operations](docs/operations.md) for
storage layout, recovery, organization rebuilds and deletion behavior.

## Privacy and data ownership

- **Local:** originals, versions, derived index and embedding inference stay on
  your machine. The server binds to loopback at `127.0.0.1`.
- **Hosted, when enabled:** Jev organization and evaluated search send selected
  text evidence to TypeSafe. Pixels are not submitted for Jev image judgments.
- **Separate outcomes:** disabling answer checking for a search does not disable
  configured background Jev organization after ingestion.
- **Backups:** stop the server and copy the **complete data directory**, including
  recovery receipts in `temp`. Test current and historical download hashes after
  restoring to a separate location.
- **Deletion:** deleting a document permanently removes all its versions after
  confirmation. Removing a folder preserves its files and histories.

Original bytes and versions belong to OCFL; the search index is derived. Do not
manually modify OCFL inventories or run unmanaged writers while the app is active.
See the [operations guide](docs/operations.md) before index repair or restoration.

## Measured performance

Verified **17 October 2026** on an **Apple M5 Pro with 48 GB RAM**. These are
observed process physical footprints, not whole-system RAM or capacity guarantees.

| Measurement | Result |
| --- | --- |
| Matched HTTP workload peak, server plus children | **6.06 → 3.98 GiB** after INT8 text weights and unloading cached embeddings before OCR. |
| Matched warm search median | **186 ms float32 / 174 ms INT8**, with pre-OCR unloading enabled in both. |
| Reload after idle, same workload | **417 ms float32 / 641 ms INT8**. |
| Final live server after the 60-second idle timeout | **720 MiB**, zero active MPS tensors. |
| Dense two-page scanned-PDF workload | **5.00 GiB** observed peak. |
| Latest recorded checks | **273 backend tests**, **21 related browser flows**, production build and Ruff passed. |

The matched workload includes bilingual text, a real photo, a 16 MiB transfer and
a ten-page PDF. Live idle is a separate observation. GPU allocator counters overlap
physical footprint and must not be added to it. Around 1 GiB describes settled
idle use, not loaded-model or OCR peaks. Native browser peak reduction was not
established by the hash-only comparison.

Generated retrieval labels are not independent production certification. Hebrew
queries over English guides remain less accurate than English queries. A
100,000-document corpus, a sustained 16 GiB whole-system ceiling and CUDA performance
have **not** been validated.

[Full results and completion checks](Optimize-memory-symbiknow.md) ·
[Benchmark scripts and scope](outputs/memory-research/followup/README.md)

## Development

For frontend hot reload, after completing the Python and rocfl setup:

```sh
npm --prefix frontend ci
sh scripts/dev.sh
```

Open `http://127.0.0.1:5173`; the shared backend runs on port `8765`. Stop the
production server first so it does not compete for the port or library owner lock.

Run the backend checks and build:

```sh
uv run --locked pytest -q
uv run --locked ruff check app client.py tests scripts
npm --prefix frontend run build
```

Browser tests use an isolated fixture server. From `frontend/`, run `npm test`.
The configuration defaults to Google Chrome on macOS; set `SYMBIKNOW_CHROME` to
your Chrome/Chromium executable elsewhere. Live model/provider checks are separate
from fixture tests:

```sh
uv run --locked python scripts/check-runtime.py
uv run --locked python scripts/check-mcp.py
```

The runtime check loads real text/image models and attempts a hosted Jev judgment.
Keep live checks separate from the running production library; read each script's
scope before running benchmarks. Memory reproduction commands and exclusions are
recorded with the [benchmark reports](outputs/memory-research/REPRODUCE.md).

## Documentation

| Guide | Contents |
| --- | --- |
| [MCP reference](docs/mcp-reference.md) | Tool arguments, transfer protocol, pagination and evidence semantics. |
| [UI guide](UI.md) | Browsing, search, Canvas, previews and version history. |
| [Architecture](docs/architecture.md) | Components, data layout and publication boundaries. |
| [Operations](docs/operations.md) | Startup, recovery, rebuilds, backup and deletion. |
| [Runtime controls](docs/memory-runtime.md) | INT8 support, fallback, index compatibility and resource limits. |
| [Memory verification](Optimize-memory-symbiknow.md) | Implemented improvements, matched measurements and remaining limits. |
| [Earlier validation](VALIDATION.md) | Dated checks and historical implementation evidence. |

## Support and license

Maintained by [Ben R.](https://github.com/benrben). For reproducible bugs or feature
requests, [open an issue](https://github.com/benrben/symbiknow/issues). Include your
platform, runtime settings, reproduction steps and sanitized errors; keep tokens,
private documents and library data out of reports.

© 2026 Ben R. All rights reserved. See [LICENSE](LICENSE) for source-use terms.
Third-party dependencies retain their own licenses and notices.
