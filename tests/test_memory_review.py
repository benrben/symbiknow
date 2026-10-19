"""Regression coverage from the independent memory implementation review."""

from pathlib import Path
import subprocess
import threading

import numpy as np
import pytest

from app import ingest, search, server, storage, ui
from test_search import FixtureEmbedder


def test_chunk_stream_uses_one_append_transaction(tmp_path, monkeypatch):
    """Embedding batch size must not become the database commit frequency."""
    table = search._table(tmp_path, "chunks", search.chunk_schema(3))
    append = type(table).add
    commits = []

    def count(self, *args, **kwargs):
        commits.append(1)
        return append(self, *args, **kwargs)

    monkeypatch.setattr(type(table), "add", count)
    spool = ingest.ChunkSpool()
    try:
        for i in range(260):
            spool.append({"chunk_id": f"d:v1:t{i}", "text": f"cat passage {i}",
                          "basis": "text", "provenance_json": "{}",
                          "vector": np.array([1, 0, .1], dtype=np.float32)})
        search.put_chunks(tmp_path, {"document_id": "d", "version": "v1"},
                          spool.reader(), "test-only-fixture")
    finally:
        spool.close()
    assert search._table(tmp_path, "chunks").count_rows("active = true") == 260
    assert len(commits) == 1


@pytest.mark.parametrize("filename", ["stderr.log", "document.json", "result.json"])
@pytest.mark.parametrize("staged", [False, True])
def test_conversion_input_cannot_collide_with_worker_artifacts(tmp_path, monkeypatch, filename, staged):
    from docling_core.types.doc import DocItemLabel, DoclingDocument

    original = b"<p>cat rests on the sofa</p>"
    pinned = tmp_path / "verified-original.bin"
    pinned.write_bytes(original)

    def child(args, **kwargs):
        source, destination = Path(args[3]), Path(args[4])
        assert source.read_bytes() == original
        document = DoclingDocument(name=filename)
        document.add_text(label=DocItemLabel.PARAGRAPH, text="cat rests on the sofa")
        document.save_as_json(destination / "document.json")
        (destination / "result.json").write_text('{"partial": false}')
        assert source.read_bytes() == original
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(ingest.subprocess, "run", child)
    units, _, warnings = ingest.extract_units(
        {"filename": filename, "mime_type": "text/html"},
        pinned if staged else original, FixtureEmbedder(), isolated=True,
    )
    assert not warnings
    assert "cat rests on the sofa" in units[0]["text"]
    assert pinned.read_bytes() == original


@pytest.mark.parametrize("page", [False, True])
def test_preview_cache_read_survives_concurrent_eviction(tmp_path, monkeypatch, page):
    """Another preview must not delete a cache hit between its check and read."""
    from app.previews import prune

    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setenv("SYMBIKNOW_PREVIEW_CACHE_BYTES", "0")
    monkeypatch.setattr(storage, "read_metadata", lambda *args: {
        "document_id": "d", "version": "v1", "mime_type": "application/pdf", "size": 1,
    })
    root = tmp_path / "temp" / "thumbnails"
    root.mkdir(parents=True)
    target = root / ("d-v1-page-1.jpg" if page else "d-v1.jpg")
    target.write_bytes(b"cached preview")
    target.with_suffix(".json").write_text('{"pages": 2}')
    checked_path = target.with_suffix(".json") if page else target
    other = root / "other-v1.jpg"
    other.write_bytes(b"other preview")
    checked, evicted = threading.Event(), threading.Event()
    exists = Path.exists

    def pause_after_check(path):
        found = exists(path)
        if path == checked_path and found and not checked.is_set():
            checked.set()
            # An atomic read owns write_lock, so eviction waits until it returns.
            evicted.wait(.2)
        return found

    def evict():
        if checked.wait(3):
            with server.write_lock:
                prune(root, other)
            evicted.set()

    monkeypatch.setattr(Path, "exists", pause_after_check)
    worker = threading.Thread(target=evict)
    worker.start()
    try:
        response = ui._pdf_page("d", "v1", 1) if page else ui._thumbnail("d", "v1")
        assert response.body == b"cached preview"
        if page:
            assert response.headers["X-PDF-Page-Count"] == "2"
    finally:
        worker.join(timeout=4)
    assert evicted.is_set() and not worker.is_alive()
