# Symbiknow original build checklist

This is the historical implementation proposal supplied on 11 October 2026. Its `planning_only` status and agent assignments describe the proposed work at that time. The application now includes implemented UI, rebuild, project-topic and relationship modules beyond that initial layout. Use the current architecture and development-status documents for present behavior.

Symbiknow / Development / Historical build plan

## Original checklist

The six phases cover dependency proof, byte transfers, indexing, Jev judgments, recovery and workload validation. The original execution record is reproduced without changing its proposed acceptance criteria.

```json
{
  "status": "planning_only",
  "approach": "Reuse open-source implementations; keep custom code to integration.",
  "phases": [
    {
      "step": 1,
      "title": "Install and prove the dependencies",
      "owner": "Lead",
      "work": "Install the MCP SDK, rocfl, LanceDB, Docling and the tested EmbeddingGemma 2 runtime. Configure Jev credentials. Pin working versions.",
      "done": "Create two versions with rocfl and read the first back. Run real text and image embeddings on the M4. Execute a structured Jev decision. Test interrupted storage commit recovery before relying on it."
    },
    {
      "step": 2,
      "title": "Make upload and download work",
      "owner": "Storage agent",
      "work": "Implement storage.py and the two MCP tool functions. One OCFL object per document. Use the library for staging, commits, history and old-version reads. Move real bytes through client.py.",
      "done": "Single and bulk transfers preserve bytes; an update keeps the same document ID and creates a new version; requested old versions download correctly. Check retries, expected-version conflicts and large-file chunk transfer."
    },
    {
      "step": 3,
      "title": "Make files searchable",
      "owner": "Search agent",
      "work": "Use Docling conversion/OCR and its existing chunker. Embed text and image units. Store metadata/chunks in LanceDB and use its built-in vector, full-text and hybrid search.",
      "done": "Find known text, HTML, PDF and image examples; every hit identifies its document/version and source page or passage. Failed extraction preserves the file."
    },
    {
      "step": 4,
      "title": "Add Jev decisions and organization",
      "owner": "Jev agent",
      "work": "Judge the top retrieved documents, select supporting evidence, assign logical folders/groups and classify links between nearby documents. Store those decisions in LanceDB.",
      "done": "Answer-mode results explain relevance using supplied evidence. Related files get groups and links. OCR/caption basis is explicit and pure visual results are not falsely presented as Jev image judgments."
    },
    {
      "step": 5,
      "title": "Join the pieces and recover after restart",
      "owner": "Lead",
      "work": "Run one daemon, serialize storage writes, and use one bounded ingestion loop. On startup reconcile OCFL heads with LanceDB indexed versions. Final-check result versions before returning them.",
      "done": "A crash after storage does not lose the original or create another version merely to retry indexing. New pending versions do not return old text labeled current. Jev outage leaves ordinary search usable."
    },
    {
      "step": 6,
      "title": "Test the real workload and ship",
      "owner": "Lead with agents fixing their own files",
      "work": "Start with about 50 labeled real questions, then test the target corpus scale. Measure search quality, query latency, indexing throughput and M4 memory during uploads. Stop the app and test a backup/restore of data.",
      "done": "Required formats, historical bytes, bulk transfers and Jev organization work. Dependency pins, actual size/host limits and startup instructions are documented. Performance claims use measurements."
    }
  ],
  "agents": [
    {
      "role": "Lead",
      "owns": [
        "app/server.py",
        "client.py",
        "pyproject.toml",
        "uv.lock",
        ".env.example",
        "README.md",
        "tests/test_mcp.py"
      ],
      "assignment": "Keep the app small. Agree shared function inputs first, wire the three tools, own client-byte transfer and integration tests. Review dependency use before adding abstractions."
    },
    {
      "role": "Storage agent",
      "owns": [
        "app/storage.py",
        "tests/test_storage.py"
      ],
      "assignment": "Wrap rocfl with a few functions for save/read/history/current version. Let it own OCFL inventories and directories. Prove version retrieval and interrupted-write behavior; do not implement another version engine."
    },
    {
      "role": "Search agent",
      "owns": [
        "app/ingest.py",
        "app/embeddings.py",
        "app/search.py",
        "tests/test_ingest.py",
        "tests/test_search.py"
      ],
      "assignment": "Use Docling conversion/chunking and LanceDB hybrid search directly. Implement only representation mapping, model calls, indexing and current-version checks. Keep ingestion bounded."
    },
    {
      "role": "Jev agent",
      "owns": [
        "app/jev.py"
      ],
      "assignment": "Use the TypeSafe SDK for bounded structured decisions. Implement relevance/evidence selection, folder/group choices and nearby-document links. Keep judgments tied to source versions and label text/OCR/caption evidence."
    }
  ],
  "parallelism": "Lead plus at most three sub-agents. Agree function arguments once; agents edit only owned files. Storage and search can start together; Jev uses sample search results until integration."
}
```

## Provenance

Original file: `agent-memory-developer-plan/execution/build-plan.json` in the supplied Codex output package. The related HTML developer plan and proposed repository tree are imported as historical reference documents. The descriptions here are reference material rather than a request to spawn agents or change current ownership.
