"""Model preparation cannot gate access to a library's stored originals."""
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import threading
import time

from filelock import FileLock, Timeout
import pytest
from starlette.testclient import TestClient

from symbiknow.api import http as ui, mcp as server
from symbiknow.embeddings import runtime
from symbiknow.embeddings.scheduling import BACKGROUND_WORK
from symbiknow.library import storage
from symbiknow.search import index


def test_slow_model_warmup_does_not_gate_http_and_keeps_owner_until_finished(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("SYMBIKNOW_WARMUP", "1")
    metadata = storage.save_file(tmp_path, b"available during model load", "original.bin")
    index.register_document(tmp_path, metadata)
    entered, release, served = threading.Event(), threading.Event(), threading.Event()
    calls, elapsed, unloaded = [], [], []

    def warmup(query):
        calls.append((query, BACKGROUND_WORK.get(), threading.current_thread().name))
        entered.set()
        assert release.wait(10), "test must release model preparation"

    monkeypatch.setattr(runtime, "get_embedder", lambda: SimpleNamespace(embed_query=warmup))
    monkeypatch.setattr(runtime, "unload_idle", lambda **kw: unloaded.append(release.is_set()))

    def serve():
        with TestClient(ui.create_app(), base_url="http://127.0.0.1") as client:
            assert entered.wait(2)
            started = time.monotonic()
            listing = client.get("/api/library")
            original = client.get("/api/original", params={"id": metadata["document_id"], "version": "v1"})
            elapsed.append(time.monotonic() - started)
            assert listing.status_code == original.status_code == 200
            assert listing.json()["total"] == 1
            assert original.content == b"available during model load"
            served.set()

    with ThreadPoolExecutor(max_workers=1) as pool:
        running = pool.submit(serve)
        try:
            assert served.wait(4), "HTTP startup/read waited for the model"
            assert not running.done(), "shutdown must wait for its warmup owner"
            with pytest.raises(Timeout):
                FileLock(tmp_path / "server.lock", timeout=0).acquire()
        finally:
            release.set()
        running.result(timeout=10)
    assert calls == [("Search ready", True, "symbiknow-model-warmup")]
    assert elapsed[0] < 1
    assert unloaded == [True]
    with FileLock(tmp_path / "server.lock", timeout=0):
        pass
