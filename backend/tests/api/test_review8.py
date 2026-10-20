"""Isolated lock-coupling reproduction; actual retrieval, controlled embedding latency."""

from concurrent.futures import ThreadPoolExecutor
import threading

from symbiknow.ingestion import service as ingest
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.library import storage
from tests.search.test_search import FixtureEmbedder


def test_keyword_search_finishes_while_another_request_waits_for_embedding(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    storage.init_storage(tmp_path)
    doc = storage.save_file(tmp_path, b"The feline cat rests.", "cat.txt")
    ingest.index_document(tmp_path, doc, b"The feline cat rests.", FixtureEmbedder())
    entered, release, completed = threading.Event(), threading.Event(), threading.Event()

    class SlowEmbedder(FixtureEmbedder):
        def embed_query(self, query):
            entered.set()
            assert release.wait(5)
            return super().embed_query(query)

    monkeypatch.setattr(search, "get_embedder", SlowEmbedder)
    with ThreadPoolExecutor(max_workers=2) as pool:
        semantic = pool.submit(server.search, "feline", mode="semantic")
        assert entered.wait(2)

        def keyword():
            result = server.search("cat", mode="keyword")
            completed.set()
            return result

        request = pool.submit(keyword)
        try:
            responsive = completed.wait(1)
        finally:
            release.set()
        assert request.result(timeout=5)["matches"][0]["document_id"] == doc["document_id"]
        assert semantic.result(timeout=5)["matches"]
    assert responsive, "Keyword retrieval was blocked by another request's embedding computation"


def test_keyword_shortlist_metadata_reads_do_not_grow_per_result(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    storage.init_storage(tmp_path)
    for i in range(17):
        content = b"The feline cat rests."
        doc = storage.save_file(tmp_path, content, f"cat-{i}.txt")
        ingest.index_document(tmp_path, doc, content, FixtureEmbedder())
    opened = []
    original = search._table

    def counted(data_dir, name, *args, **kwargs):
        if name == "documents":
            opened.append(name)
        return original(data_dir, name, *args, **kwargs)

    monkeypatch.setattr(search, "_table", counted)
    small = server.search("cat", mode="keyword", limit=1)
    small_reads = len(opened)
    opened.clear()
    large = server.search("cat", mode="keyword", limit=40)
    assert len(small["matches"]) == 1 and len(large["matches"]) == 17
    assert len(opened) <= small_reads + 1
