"""Deterministic fixture embeddings test integration, not model retrieval quality."""

import hashlib

import pytest
from docling_core.transforms.chunker.tokenizer.base import BaseTokenizer

from app import storage
from app.ingest import index_document
from app.search import (
    document_evidence,
    find_documents,
    get_document_status,
    invalidate_related_organization,
    mark_pending,
    organization_catalog,
    save_organization,
)


def _save(root, filename, content, **kwargs):
    return storage.save_file(root, content, filename, **kwargs)


class FixtureTokenizer(BaseTokenizer):
    def count_tokens(self, text):
        return len(text.split())

    def get_max_tokens(self):
        return 512

    def get_tokenizer(self):
        return self.count_tokens


class FixtureEmbedder:
    """Explicit test-only vectors; never selected by application configuration."""

    model_id = "test-only-fixture"
    chunk_tokenizer = FixtureTokenizer()

    def embed_documents(self, texts, title="none"):
        return [self.embed_query(text) for text in texts]

    def embed_query(self, text):
        text = text.lower()
        return [
            1.0 if any(t in text for t in ("cat", "feline")) else 0.0,
            1.0 if any(t in text for t in ("dog", "canine")) else 0.0,
            0.1,
        ]

    def embed_images(self, images):
        return [[1.0, 0.0, 0.1] for _ in images]


@pytest.fixture
def corpus(tmp_path):
    storage.init_storage(tmp_path)
    return tmp_path, FixtureEmbedder()


def _add(root, embedder, name, content, **kwargs):
    meta = _save(root, name, content, **kwargs)
    assert index_document(root, meta, content, embedder)["status"] == "indexed"
    return meta


@pytest.mark.parametrize("mode", ["semantic", "hybrid", "keyword"])
def test_retrieval_and_evidence(corpus, mode):
    root, embedder = corpus
    cat = _add(root, embedder, "cat.md", b"# Animals\n\nThe feline cat rests on a sofa.")
    _add(
        root,
        embedder,
        "dog.html",
        b"<html><body><h1>Dogs</h1><p>The canine dog walks.</p></body></html>",
    )
    matches = find_documents(root, "cat", mode=mode, embedder=embedder)
    assert matches[0]["document_id"] == cat["document_id"]
    assert matches[0]["version"] == "v1"
    assert "cat rests" in matches[0]["evidence"][0]["text"]
    assert matches[0]["evidence"][0]["basis"] == "text"


def test_unindexed_head_never_returns_old_content(corpus):
    root, embedder = corpus
    old = _add(root, embedder, "animal.txt", b"cat rests")
    new = _save(root, "animal.txt", b"dog walks", document_id=old["document_id"])
    # Crash window: OCFL has v2 while index still advertises v1.
    assert find_documents(root, "cat", mode="keyword") == []
    mark_pending(root, new)
    assert find_documents(root, "cat", mode="keyword") == []
    assert index_document(root, new, b"dog walks", embedder)["status"] == "indexed"
    matches = find_documents(root, "dog", embedder=embedder)
    assert matches[0]["version"] == "v2"
    assert "cat" not in str(matches[0]["evidence"])


def test_retry_replaces_chunks_without_new_version(corpus):
    root, embedder = corpus
    meta = _add(root, embedder, "cat.txt", b"cat rests")
    index_document(root, meta, b"cat rests", embedder)
    assert len(document_evidence(root, meta["document_id"], "v1")) == 1
    assert len(storage.list_versions(root, meta["document_id"])) == 1
    assert get_document_status(root, meta["document_id"])["indexed_version"] == "v1"


def test_metadata_organization_and_filter(corpus):
    root, embedder = corpus
    meta = _add(root, embedder, "cat.txt", b"cat rests")
    save_organization(
        root,
        meta["document_id"],
        "v1",
        {
            "status": "evaluated",
            "folder": "Animals",
            "groups": ["pets"],
            "links": [],
        },
    )
    assert organization_catalog(root) == {
        "folders": ["Animals"],
        "groups": ["pets"],
        "projects": [],
    }
    assert find_documents(root, "cat", folder="Animals", group="pets", embedder=embedder)
    assert not find_documents(root, "cat", folder="Other", embedder=embedder)
    with pytest.raises(ValueError, match="superseded"):
        save_organization(root, meta["document_id"], "v2", {})
    save_organization(root, meta["document_id"], "v1", {"groups": [], "status": "evaluated"})
    assert not find_documents(root, "cat", group="pets", embedder=embedder)


def test_bad_index_bytes_are_failed_and_original_survives(corpus):
    root, embedder = corpus
    meta = _save(root, "cat.txt", b"cat rests")
    result = index_document(root, meta, b"altered", embedder)
    assert result["status"] == "failed"
    assert "SHA-256" in result["index_error"]
    assert (
        hashlib.sha256(storage.read_file(root, meta["document_id"])[0]).hexdigest()
        == meta["sha256"]
    )


def test_related_document_update_expires_versioned_link(corpus):
    root, embedder = corpus
    cat = _add(root, embedder, "cat.txt", b"cat rests")
    dog = _add(root, embedder, "dog.txt", b"dog walks")
    save_organization(
        root,
        cat["document_id"],
        "v1",
        {
            "status": "evaluated",
            "links": [
                {
                    "document_id": dog["document_id"],
                    "source_chunk_id": f"{cat['document_id']}:v1:t0",
                    "target_chunk_id": f"{dog['document_id']}:v1:t0",
                    "version": "v1",
                    "source_version": "v1",
                    "relation": "related",
                }
            ],
        },
    )
    assert find_documents(root, "cat", mode="keyword")[0]["links"]
    _save(root, "dog.txt", b"dog runs", document_id=dog["document_id"])
    assert find_documents(root, "cat", mode="keyword")[0]["links"] == []
    assert invalidate_related_organization(root, dog["document_id"]) == [cat["document_id"]]
    source = get_document_status(root, cat["document_id"])
    assert source["organization_status"] == "pending" and source["links_json"] == "[]"


def test_organization_candidates_reserve_same_project_topic_despite_global_distractors(
    corpus, monkeypatch
):
    from pathlib import Path
    from app import search
    from app.jev import organize_document
    from test_jev import sdk_client

    root, embedder = corpus
    fixture = Path(__file__).parent / "fixtures" / "review-4"
    source = _add(root, embedder, "one.txt", (fixture / "QA-R4-01.txt").read_bytes())
    peer = _add(root, embedder, "two.txt", (fixture / "QA-R4-02.txt").read_bytes())
    _add(root, embedder, "access.txt", (fixture / "QA-R4-04.txt").read_bytes())
    distractors = [
        _add(
            root,
            embedder,
            f"other-{i}.txt",
            (fixture / "QA-R4-05.txt").read_bytes() + str(i).encode(),
        )
        for i in range(8)
    ]
    # A deliberately poor vector result demonstrates that the content-based FTS
    # candidate pass can recover the correct peer before Jev's five-neighbor cap.
    original_find = search.find_documents

    def crowded(data_dir, query, mode="hybrid", **kwargs):
        if mode == "semantic":
            return [
                {**doc, "evidence": document_evidence(root, doc["document_id"], "v1")}
                for doc in distractors
            ]
        return original_find(data_dir, query, mode=mode, **kwargs)

    monkeypatch.setattr(search, "find_documents", crowded)
    evidence = document_evidence(root, source["document_id"], "v1")
    candidates = search.organization_neighbors(root, source, evidence)
    assert candidates[0]["document_id"] == peer["document_id"]
    with sdk_client({"link_0": "related", "source_0": "p0", "target_0": "p0"}) as sdk:
        decision = organize_document(source, evidence, candidates, client=sdk)
    assert [link["document_id"] for link in decision["links"]] == [peer["document_id"]]
    audits = decision["link_evaluations"]
    assert len(audits) == 5
    assert audits[0]["accepted"] and audits[0]["document_id"] == peer["document_id"]
    assert all(not item["accepted"] and item["relation"] == "none" for item in audits[1:])
    # Retrieval does not assert a link when the provider declines it.
    with sdk_client() as sdk:
        assert organize_document(source, evidence, candidates, client=sdk)["links"] == []
