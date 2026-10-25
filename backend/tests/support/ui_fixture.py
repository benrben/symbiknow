"""Isolated browser server with actual originals/indexes and TEST-ONLY 3D vectors.

This fixture does not measure model quality or real-runtime compatibility.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import json
import os
import tempfile
import uuid
from io import BytesIO
from types import SimpleNamespace

from PIL import Image, ImageDraw
import uvicorn
from symbiknow.api import mcp as server
from symbiknow.library import storage
from symbiknow.search import index as search
from symbiknow.ingestion import service as ingest
from symbiknow.ai import jev
from symbiknow.api import http as ui
from symbiknow.embeddings import runtime as embeddings
from tests.search.test_search import FixtureEmbedder


class BrowserEmbedder(FixtureEmbedder):
    """Explicit deterministic vectors for UI evidence fixtures, not quality claims."""

    def embed_query(self, text):
        text = text.lower()
        return (
            [1.0, 0.0, 0.1]
            if "each update is saved" in text or text == "keep every version"
            else [0.0, 1.0, 0.1]
        )


def validate_fixture_index(data_dir):
    """The injected fake owns only its explicit dimensions/model, never real weights."""
    table = search._table(data_dir, "chunks")
    if table is not None and (
        table.schema.field("vector").type.list_size != 3
        or table.search().where("embedding_model != 'test-only-fixture'")
        .select(["chunk_id"]).limit(1).to_list()
    ):
        raise embeddings.EmbeddingUnavailable("Browser fixture index contains another embedding model")


def add_metadata_rows(data_dir, count):
    """Synthetic UI capacity only: no originals, fake heads or retrieval claims."""
    from symbiknow.organization.store import publish

    rows = []
    for i in range(count):
        rows.append(search._document_row(
            {
                "document_id": str(uuid.uuid5(uuid.NAMESPACE_DNS, f"metadata-benchmark-{i}")),
                "version": "v1",
                "filename": f"Benchmark {i:06}.txt",
                "mime_type": "text/plain",
                "created_at": "2026-10-12T00:00:00+00:00",
            },
            status="disabled",
            folder=f"Benchmark / Batch {i % 20:02}",
        ))
    search._table(data_dir, "documents", search.DOCUMENT_SCHEMA).add(rows)
    # Organization columns in the evidence table are no longer authoritative.
    # Publish the same synthetic epoch/version through the canonical owner.
    publish(data_dir, rows)


def connect(temporary, docs, relations):
    for source_index, target_index, relation in relations:
        source, target = docs[source_index], docs[target_index]
        se = search.document_evidence(temporary, source["document_id"], source["version"])[0]
        te = search.document_evidence(temporary, target["document_id"], target["version"])[0]
        row = search.get_document_status(temporary, source["document_id"])
        search.save_organization(
            temporary,
            source["document_id"],
            source["version"],
            {
                "status": "evaluated",
                "folder": row["folder"],
                "groups": row["groups"],
                "links": [
                    {
                        "document_id": target["document_id"],
                        "version": target["version"],
                        "source_version": source["version"],
                        "relation": relation,
                        "source_chunk_id": se["evidence_id"],
                        "target_chunk_id": te["evidence_id"],
                    }
                ],
            },
        )


def main():
    # The quality gate serves an instrumented build with source maps from its own folder.
    if os.environ.get("SYMBIKNOW_UI_BUILD"):
        ui.BUILD = Path(os.environ["SYMBIKNOW_UI_BUILD"])
    with tempfile.TemporaryDirectory(prefix="symbiknow-browser-") as temporary:
        server.DATA_DIR = Path(temporary)
        server.STORAGE_ONLY = False
        os.environ["TYPESAFE_API_KEY"] = "browser-fixture-not-a-real-key"
        embedder = BrowserEmbedder()
        embeddings.get_embedder = lambda: embedder
        search.get_embedder = lambda: embedder
        ingest.get_embedder = lambda: embedder
        # Background ingestion uses the same injected fake as initial seeding;
        # production compatibility checks remain unchanged in symbiknow.embeddings.runtime.
        embeddings.validate_index = validate_fixture_index

        def test_call(state, questions, client=None):
            # Pure local fixture: no HTTP client, transport, provider or credentials.
            # SDK serialization is covered separately by test_jev.py's MockTransport.
            if os.environ.get("SYMBIKNOW_REVIEW_FIXTURE"):
                import time

                time.sleep(1.5)  # Make genuine job progress observable in this opt-in fixture.
            labels = {"judge_0": "direct", "judge_1": "partial", "judge_2": "related"}
            if "documents" in state and any(k.startswith("relation_") for k in questions):
                # Explicit synthetic maintenance findings for browser workflow
                # tests. This tests UI behavior, not hosted model quality.
                labels.update({key: "same" if key.startswith(("subject_", "setting_")) else
                               "applicable" if key.startswith("period_") else "incompatible" for key in questions})
            return SimpleNamespace(
                model="jev-browser-fixture",
                choices={
                    key: SimpleNamespace(
                        choice=labels.get(key, next(iter(question.criteria))), confidence=0.95,
                        probabilities={option: float(option == labels.get(key, next(iter(question.criteria))))
                                       for option in question.criteria},
                    )
                    for key, question in questions.items()
                    if question.type == "choice"
                },
                nouls={
                    key: SimpleNamespace(
                        noul=0.01
                        if key.startswith(
                            (
                                "conflict_", "premise_", "disagreement_", "cross_", "period_",
                                "historical_", "obsolete_", "scope_mismatch_",
                            )
                        )
                        else 0.95
                    )
                    for key, question in questions.items()
                    if question.type == "noul"
                },
            )

        jev._call = test_call
        storage.init_storage(temporary)
        fixtures = [
            (
                "storage-decisions.md",
                "Engineering",
                "# Keep every version\n\nEach update is saved as a new version. Earlier files stay available whenever you need them.\n\nOriginal file contents are preserved independently of the search index.",
            ),
            (
                "retrieval-notes.md",
                "Research",
                "# Retrieval notes\n\nSemantic search finds useful evidence over content. Keep every version and retrieve original files.\n\n## Key ideas\n\n- Semantic search over content\n- Chunking and retrieval\n- Simple, reliable workflows",
            ),
            (
                "model-comparison.txt",
                "Research",
                "Model comparison\n\nKeep every version of your research. Compare the meaning of a question with stored passages.\n\nModel A: fast, lightweight\nModel B: balanced\nModel C: longer documents",
            ),
            (
                "api-reference.html",
                "Engineering",
                "<!doctype html><html><body><h1>API reference</h1><p>Upload, download and search files.</p><p>Keep every version with document_id and expected_version.</p></body></html>",
            ),
            (
                "product-brief.md",
                "Product",
                "# Personal knowledge library\n\nAdd files, find useful evidence, explore connections and retrieve the right version.",
            ),
            (
                "release-plan.md",
                "Product",
                "# Release plan\n\nOne local library with file history. Clear search and approachable previews.",
            ),
        ]
        if os.environ.get("SYMBIKNOW_REVIEW_FIXTURE"):
            fixtures.append((
                "unfiled-symbiknow-notes.md", "",
                "# Symbiknow project\n\nSymbiknow preserves every document version. "
                "Symbiknow searches stored evidence and displays linked project documents.",
            ))
        design = bool(os.environ.get("SYMBIKNOW_DESIGN_FIXTURE"))
        if design:
            repository = Path(__file__).resolve().parents[3]
            fixtures = [
                (name, folder, (repository / source).read_text())
                for source, name, folder in [
                    ("backend/tests/fixtures/library/UI.txt", "Symbiknow UI guide.md", "Symbiknow / Development"),
                    (
                        "backend/tests/fixtures/library/architecture.txt",
                        "Symbiknow architecture.md",
                        "Symbiknow / Development",
                    ),
                    (
                        "backend/tests/fixtures/library/current-status.txt",
                        "Current development status.md",
                        "Symbiknow / Development",
                    ),
                    (
                        "backend/tests/fixtures/library/mcp-reference.txt",
                        "Symbiknow MCP reference.md",
                        "Symbiknow / Development",
                    ),
                    ("backend/tests/fixtures/library/README.txt", "Symbiknow README.md", "Symbiknow / Operations"),
                    ("backend/tests/fixtures/library/operations.txt", "Symbiknow operations.md", "Symbiknow / Operations"),
                    ("backend/tests/fixtures/library/VALIDATION.txt", "Symbiknow validation record.md", "Symbiknow / Operations"),
                    (
                        "backend/tests/fixtures/library/project-library.txt",
                        "Symbiknow project documentation.md",
                        "Project records",
                    ),
                    (
                        "backend/tests/fixtures/library/original-build-plan.txt",
                        "Original build checklist.md",
                        "Project records",
                    ),
                    ("backend/tests/fixtures/library/performance-evidence.txt", "Performance evidence.md", "Project records"),
                    ("backend/tests/fixtures/library/ocfl_1.1.txt", "OCFL 1.1 specification.md", "Storage references"),
                    (
                        "backend/tests/fixtures/library/0004-hashed-n-tuple-storage-layout.txt",
                        "Hashed n tuple layout.md",
                        "Storage references",
                    ),
                ]
            ]
        docs = []
        for name, folder, text in fixtures:
            m = storage.save_file(
                temporary, text.encode(), name, source=f"/fixtures/{folder}/{name}"
            )
            if name == "storage-decisions.md":
                for number in (2, 3):
                    m = storage.save_file(
                        temporary,
                        (
                            text
                            if number == 3
                            else "# Earlier storage decision\n\nKeep the original version."
                        ).encode(),
                        name,
                        document_id=m["document_id"],
                        source=f"/fixtures/{folder}/{name}",
                    )
            content, _ = storage.read_file(temporary, m["document_id"])
            ingest.index_document(temporary, m, content, embedder)
            search.save_organization(
                temporary,
                m["document_id"],
                m["version"],
                {
                    "status": "evaluated",
                    "folder": folder,
                    "groups": ["Versioning"] if "version" in text else [],
                    "links": [],
                },
            )
            docs.append(m)
        if design:
            connect(temporary, docs, [(0, 1, "related"), (1, 5, "supports"), (4, 5, "related")])
            uvicorn.run(
                ui.create_app(),
                host="127.0.0.1",
                port=int(os.environ.get("SYMBIKNOW_UI_PORT", "8766")),
                log_level="warning",
            )
            return
        picture = Image.new("RGB", (300, 380), "white")
        draw = ImageDraw.Draw(picture)
        for box, label in [
            ((110, 20, 190, 65), "Client"),
            ((110, 125, 190, 170), "API"),
            ((30, 260, 120, 310), "Storage"),
            ((180, 260, 280, 310), "Indexing"),
        ]:
            draw.rounded_rectangle(box, 8, fill="#eaf3ff", outline="#92bfff", width=2)
            draw.text((box[0] + 12, box[1] + 14), label, fill="#1d1d1f")
        draw.line([(150, 65), (150, 125)], fill="#7f899a", width=2)
        draw.line([(150, 170), (150, 220), (75, 220), (75, 260)], fill="#7f899a", width=2)
        draw.line([(150, 220), (230, 220), (230, 260)], fill="#7f899a", width=2)
        buf = BytesIO()
        picture.save(buf, format="PNG")
        m = storage.save_file(temporary, buf.getvalue(), "system-overview.png")
        rows = [
            {
                "chunk_id": f"{m['document_id']}:v1:v0",
                "text": "",
                "basis": "visual",
                "provenance_json": json.dumps({"page": 1}),
                "vector": [1.0, 0.0, 0.1],
            }
        ]
        search.put_chunks(temporary, m, rows, embedder.model_id)
        search.set_document_status(
            temporary,
            m,
            status="indexed",
            indexed_version="v1",
            searchable_visual=True,
            chunk_count=1,
        )
        search.save_organization(
            temporary,
            m["document_id"],
            "v1",
            {"status": "evaluated", "folder": "Engineering", "groups": [], "links": []},
        )
        docs.append(m)
        for source_index, target_index, relation in [(1, 0, "supports"), (0, 3, "related")]:
            source, target = docs[source_index], docs[target_index]
            se = search.document_evidence(temporary, source["document_id"], source["version"])[0]
            te = search.document_evidence(temporary, target["document_id"], target["version"])[0]
            row = search.get_document_status(temporary, source["document_id"])
            search.save_organization(
                temporary,
                source["document_id"],
                source["version"],
                {
                    "status": "evaluated",
                    "folder": row["folder"],
                    "groups": row["groups"],
                    "links": [
                        {
                            "document_id": target["document_id"],
                            "version": target["version"],
                            "source_version": source["version"],
                            "relation": relation,
                            "source_chunk_id": se["evidence_id"],
                            "target_chunk_id": te["evidence_id"],
                        }
                    ],
                },
            )
        if os.environ.get("SYMBIKNOW_MEDIA_FIXTURE"):
            from tests.support.media_samples import add_media_samples

            add_media_samples(temporary, embedder)
        if os.environ.get("SYMBIKNOW_DECISION_FIXTURE"):
            # Opt-in deterministic uncertainty; no hosted model calls.
            source, target = docs[:2]
            se = search.document_evidence(temporary, source["document_id"], source["version"])[0]
            te = search.document_evidence(temporary, target["document_id"], target["version"])[0]
            target_row = search.get_document_status(temporary, target["document_id"])
            search.save_organization(temporary, source["document_id"], source["version"], {
                "status": "evaluated", "folder": "", "groups": [], "links": [],
                "evidence_ids": [se["evidence_id"]],
                "ownership": {"outcome": "multiple_projects", "candidates": {"o0": "Engineering", "o1": "Research"}},
                "dependency_evidence_revisions": {target["document_id"]: target_row["evidence_revision"]},
                "link_evaluations": [{"document_id": target["document_id"], "version": target["version"],
                    "source_chunk_id": se["evidence_id"], "target_chunk_id": te["evidence_id"],
                    "accepted": False, "relation": "none", "topic": .67}],
            })
        metadata_rows = int(os.environ.get("SYMBIKNOW_METADATA_ROWS", "0"))
        if metadata_rows:
            # Added rows deliberately have no OCFL originals; normal startup
            # integrity recovery would correctly purge them. This metadata-only
            # benchmark excludes that recovery phase rather than faking originals.
            search.recover_deleted_index = lambda *_: None
            # Synthetic derived rows only: this fixture measures metadata/UI limits,
            # never original-file integrity, indexing throughput or model quality.
            add_metadata_rows(temporary, metadata_rows)
            original_library = ui.library

            def benchmark_library(params):
                import resource

                value = original_library(params)
                value["benchmark_server_peak_rss_mib"] = (
                    resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576
                )
                return value

            ui.library = benchmark_library
        uvicorn.run(
            ui.create_app(),
            host="127.0.0.1",
            port=int(os.environ.get("SYMBIKNOW_UI_PORT", "8766")),
            log_level="warning",
        )


if __name__ == "__main__":
    main()
