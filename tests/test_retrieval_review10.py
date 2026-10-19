"""Pinned passage inclusion with replayed rank order, real index/OCFL freshness."""

import json
from pathlib import Path

import pytest

from app import jev, search, server, storage

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures/review10-passage-selection.json").read_text()
)


class FixedEmbedder:
    model_id = "review10-rank-replay"

    def embed_query(self, query):
        return [1.0, 0.0, 0.1]


@pytest.fixture
def pinned_corpus(tmp_path, monkeypatch):
    # Original OCFL bytes are synthetic; extracted windows are copied verbatim
    # from pinned review10 receipts. Model/candidate ranking is explicitly replayed.
    root = tmp_path
    doc = storage.save_file(
        root, b"prior fixture version", FIXTURE["filename"], document_id=FIXTURE["document_id"]
    )
    doc = storage.save_file(
        root,
        b"pinned extracted fixture windows",
        FIXTURE["filename"],
        document_id=doc["document_id"],
    )
    rows = [
        dict(
            chunk_id=e["evidence_id"],
            text=e["text"],
            basis=e["basis"],
            vector=[1.0, 0.0, 0.1],
            provenance_json=json.dumps(e["provenance"]),
        )
        for e in FIXTURE["evidence"]
    ]
    search.put_chunks(root, doc, rows, FixedEmbedder.model_id)
    search.set_document_status(
        root, doc, status="indexed", indexed_version="v2", chunk_count=len(rows)
    )
    search.save_organization(
        root, doc["document_id"], "v2", dict(status="evaluated", folder="Symbiknow", groups=[])
    )
    candidates = []
    stored = {r["chunk_id"]: r for r in search._table(root, "chunks").search().limit(100).to_list()}
    for i, ref in enumerate(FIXTURE["limit8_ranked_ids"]):
        candidates.append(dict(stored[ref], _relevance_score=1.0 - i * 0.01))
    for i in range(7):
        other = storage.save_file(root, b"generic document versions", f"other-{i}.txt")
        search.put_chunks(
            root,
            other,
            [
                dict(
                    chunk_id=f"{other['document_id']}:v1:t0",
                    text="generic document versions",
                    basis="text",
                    vector=[1.0, 0.0, 0.1],
                    provenance_json="{}",
                )
            ],
            FixedEmbedder.model_id,
        )
        search.set_document_status(
            root, other, status="indexed", indexed_version="v1", chunk_count=1
        )
        search.save_organization(
            root,
            other["document_id"],
            "v1",
            dict(status="evaluated", folder="Symbiknow", groups=[]),
        )
        row = (
            search._table(root, "chunks")
            .search()
            .where(f"document_id = '{other['document_id']}'")
            .limit(1)
            .to_list()[0]
        )
        candidates.append(dict(row, _relevance_score=0.5 - i * 0.01))
    table = search._table
    limits = []

    class Builder:
        def select(self, columns):
            assert "vector" not in columns
            return self

        def where(self, *args, **kwargs):
            return self

        def vector(self, *args):
            return self

        def text(self, *args):
            return self

        def rerank(self, **kwargs):
            return self

        def distance_type(self, *args):
            return self

        def limit(self, n):
            limits.append(n)
            return self

        def to_list(self):
            return candidates

    class Table:
        def __init__(self, table):
            self.table = table

        def search(self, *args, **kwargs):
            if kwargs.get("query_type") == "hybrid":
                return Builder()
            return self.table.search(*args, **kwargs)

        def __getattr__(self, name):
            return getattr(self.table, name)

    monkeypatch.setattr(
        search,
        "_table",
        lambda *args, **kwargs: (
            Table(table(*args, **kwargs)) if args[1] == "chunks" else table(*args, **kwargs)
        ),
    )
    monkeypatch.setattr(search, "get_embedder", FixedEmbedder)
    monkeypatch.setattr(server, "DATA_DIR", root)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    return root, doc, limits


def test_limit8_top_document_preserves_pinned_intro_without_deeper_retrieval(pinned_corpus):
    root, doc, limits = pinned_corpus
    result = server.search(
        FIXTURE["query"], mode="hybrid", limit=8, folder="Symbiknow", detail="full"
    )
    top = result["matches"][0]
    assert top["document_id"] == doc["document_id"] and top["retrieval"]["rank"] == 1
    refs = [e["evidence_id"] for e in top["evidence"]]
    assert refs[:3] == FIXTURE["limit8_ranked_ids"]
    assert doc["document_id"] + ":v2:t0" in refs
    assert len(refs) <= 12
    assert limits == [64]  # unchanged global candidate budget, no secondary retrieval
    assert len(result["matches"]) == 8 and result["metrics"]["head_reads"] == 16
    from app import jev_proof

    evaluated = jev_proof.documents([top], FIXTURE["query"])[0]["evidence"]
    intro = next(e for e in evaluated if e["chunk_id"].endswith(":t0"))
    assert "OCFL" in intro["text"] and "without Git" in intro["text"]
    assert len(evaluated) <= 12


def test_added_intro_remains_subject_to_final_head_validation(pinned_corpus, monkeypatch):
    root, doc, limits = pinned_corpus

    def provider(query, matches, **kwargs):
        top = matches[0]
        evaluated = jev._evidence(top, query)
        ref = doc["document_id"] + ":v2:t0"
        assert ref in {e["chunk_id"] for e in evaluated}
        top["jev"] = dict(
            status="evaluated",
            label="direct",
            supporting_chunk_ids=[ref],
            evaluated_evidence=evaluated,
        )
        storage.save_file(root, b"new content version", "new.txt", document_id=doc["document_id"])
        return dict(status="evaluated", matches=matches)

    monkeypatch.setattr(jev, "judge_matches", provider)
    result = server.search(
        FIXTURE["query"], mode="hybrid", limit=8, folder="Symbiknow", evaluate=True, detail="full"
    )
    assert doc["document_id"] not in {m["document_id"] for m in result["matches"]}
