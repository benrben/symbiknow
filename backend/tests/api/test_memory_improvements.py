"""Resource ownership, bounded work and durable recovery regressions."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

import numpy as np
from PIL import Image
import pytest

from symbiknow.embeddings import runtime as embeddings
from symbiknow.ingestion import service as ingest
from symbiknow.organization import edits as organization_edits
from symbiknow.core import retry
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.library import storage
from symbiknow.api import http as ui
from symbiknow.previews.service import PreviewBusy, PreviewJobs
from tests.search.test_search import FixtureEmbedder


class Runtime:
    def __init__(self, vision=False):
        self.vision = vision
        self.model = object()

    def encode(self, items, **kwargs):
        return np.ones((len(items), 3), dtype=np.float32)

    def clear(self):
        pass


def test_conversion_child_has_its_own_wall_deadline():
    code = (
        "import os,time; from symbiknow.ingestion.conversion.worker import start_guard; "
        "start_guard(os.getppid(), .1, '.'); time.sleep(10)"
    )
    child = subprocess.run([sys.executable, "-c", code], timeout=5)
    assert child.returncode == 124


@pytest.mark.skipif(not hasattr(os, "fork"), reason="POSIX parent-death integration")
def test_conversion_child_exits_after_parent_death_and_cleans_scratch():
    import tempfile

    with tempfile.TemporaryDirectory(prefix="symbiknow-convert-") as scratch:
        scratch = Path(scratch)
        # The intermediate owner exits only once the guarded worker starts.
        code = """
import os,sys,time
from pathlib import Path
parent=os.fork()
if parent==0:
    from symbiknow.ingestion.conversion.worker import start_guard
    start_guard(os.getppid(), 4, sys.argv[1])
    Path(sys.argv[1], 'ready').touch()
    time.sleep(10)
else:
    while not Path(sys.argv[1], 'ready').exists(): time.sleep(.01)
    os._exit(0)
"""
        # Keep the reaping owner separate: child output is never piped to pytest.
        owner = subprocess.Popen([sys.executable, "-c", code, str(scratch)])
        assert owner.wait(timeout=5) == 0
        deadline = time.monotonic() + 5
        while scratch.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert not scratch.exists()


@pytest.mark.parametrize("permanent", [False, True])
def test_child_conversion_failures_preserve_retry_classification(monkeypatch, permanent):
    from types import SimpleNamespace
    from symbiknow.ingestion.conversion import manager as conversion_manager

    def child(*args, **kwargs):
        error = ValueError if permanent else RuntimeError
        raise error("Docling conversion failed; original is safe")

    monkeypatch.setattr(conversion_manager, "get_conversion_manager",
                        lambda: SimpleNamespace(convert=child))
    expected = ValueError if permanent else RuntimeError
    with pytest.raises(expected, match="original is safe"):
        ingest.extract_units(
            {"filename": "test.pdf", "mime_type": "application/pdf"},
            b"pdf",
            FixtureEmbedder(),
            isolated=True,
        )


def test_model_owner_serializes_load_and_unload():
    entered, release, unloaded = threading.Event(), threading.Event(), threading.Event()
    factories = []

    class Slow(Runtime):
        def encode(self, *args, **kwargs):
            entered.set()
            assert release.wait(3)
            return super().encode(*args, **kwargs)

    def factory(**kwargs):
        factories.append(1)
        return Slow(**kwargs)

    manager = embeddings.ModelManager(factory=factory, timeout=0)
    with ThreadPoolExecutor(3) as pool:
        first = pool.submit(manager.embed_query, "cat")
        assert entered.wait(2)
        second = pool.submit(manager.embed_query, "חתול")
        unload = pool.submit(lambda: (manager.unload(force=True), unloaded.set()))
        assert not unloaded.wait(0.05)
        release.set()
        assert first.result().dtype == np.float32
        second.result()
        unload.result()
    assert len(factories) == 1
    assert not manager.stats()["loaded"]


def test_heavy_conversion_releases_cached_embeddings_before_starting_child(monkeypatch):
    events = []

    class Owner(FixtureEmbedder):
        def conversion_boundary(self):
            events.append("weights_released")

    from types import SimpleNamespace
    from symbiknow.ingestion.conversion import manager as conversion_manager

    def child(*args, **kwargs):
        assert events == ["weights_released"]
        events.append("child_started")
        raise ValueError("Docling conversion failed; original is safe")

    monkeypatch.setattr(conversion_manager, "get_conversion_manager",
                        lambda: SimpleNamespace(convert=child))
    with pytest.raises(ValueError, match="original is safe"):
        ingest.extract_units({"filename": "test.pdf", "mime_type": "application/pdf"}, b"pdf", Owner(), isolated=True)
    assert events == ["weights_released", "child_started"]


def test_vision_replaces_text_and_idle_releases_weights():
    manager = embeddings.ModelManager(factory=Runtime, timeout=0.05)
    manager.embed_query("cat")
    first = manager.runtime
    manager.embed_images([object()])
    assert not hasattr(first, "model")
    assert manager.loads == 2 and manager.runtime.vision
    manager.job_boundary()
    assert not manager.stats()["loaded"]
    manager.embed_query("cat")
    deadline = time.monotonic() + 2
    while manager.runtime is not None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert manager.runtime is None


def test_embedding_failure_does_not_load_second_runtime():
    calls = []

    def broken(**kwargs):
        calls.append(1)
        raise RuntimeError("missing weights")

    manager = embeddings.ModelManager(factory=broken, timeout=0)
    with pytest.raises(embeddings.EmbeddingUnavailable, match="No second fallback"):
        manager.embed_query("cat")
    assert calls == [1]


def test_runtime_diagnostics_do_not_load_weights(monkeypatch):
    from starlette.testclient import TestClient

    def forbidden(**kwargs):
        pytest.fail("diagnostics must not load weights")

    manager = embeddings.ModelManager(factory=forbidden, timeout=0)
    monkeypatch.setattr(embeddings, "get_embedder", lambda: manager)
    client = TestClient(ui.create_app(), base_url="http://127.0.0.1")
    response = client.get("/api/runtime")
    assert response.status_code == 200
    assert response.json()["model"]["loads"] == 0
    assert response.json()["model"]["loaded"] is False


def test_runtime_migration_requires_matching_manifest(tmp_path, monkeypatch):
    monkeypatch.setenv("SYMBIKNOW_EMBEDDING_RUNTIME", "torch")
    embeddings.validate_index(tmp_path)
    record = tmp_path / "index/embedding-runtime.json"
    value = json.loads(record.read_text())
    value["dimensions"] = 512
    record.write_text(json.dumps(value))
    with pytest.raises(embeddings.EmbeddingUnavailable, match="manifest"):
        embeddings.validate_index(tmp_path)


def test_version_pinned_stream_is_extracted_once_and_leases_survive_eviction(tmp_path, monkeypatch):
    body = b"original bytes" * 100000
    meta = storage.save_file(tmp_path, body, "large.bin")
    original = storage.subprocess.run
    calls = []

    def run(args, **kwargs):
        if "original" in args and "ls" in args:
            calls.append(1)
        return original(args, **kwargs)

    monkeypatch.setattr(storage.subprocess, "run", run)
    for _ in range(3):
        with storage.verified_file(tmp_path, meta["document_id"]) as (path, pinned):
            assert pinned == meta
            with path.open("rb") as source:
                assert source.read(13) == body[:13]
    assert len(calls) == 1
    monkeypatch.setenv("SYMBIKNOW_TRANSFER_CACHE_BYTES", "0")
    with storage.verified_file(tmp_path, meta["document_id"]) as (path, _):
        assert path.exists()
        storage.save_file(tmp_path, b"new head", "new.bin", document_id=meta["document_id"])
        assert path.read_bytes() == body
    assert not path.exists()


def test_delete_between_response_creation_and_file_open_preserves_lease(tmp_path, monkeypatch):
    from starlette.applications import Starlette
    from starlette.routing import Route
    from starlette.testclient import TestClient

    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    body = b"original bytes"
    meta = storage.save_file(tmp_path, body, "original.txt")
    response = ui.original(meta["document_id"], "v1")
    path = response.path
    storage.delete_document(tmp_path, meta["document_id"], "v1")
    assert path.exists()
    with pytest.raises(FileNotFoundError):
        with storage.verified_file(tmp_path, meta["document_id"], "v1"):
            pytest.fail("deleted originals cannot start a new read")
    client = TestClient(Starlette(routes=[Route("/download", lambda request: response)]))
    result = client.get("/download", headers={"Range": "bytes=3-7"})
    assert result.status_code == 206 and result.content == body[3:8]
    assert not path.exists()
    assert path not in storage._TRANSFER_DELETED


def test_staged_upload_and_old_receipt_repair(tmp_path, monkeypatch):
    staged = tmp_path / "incoming"
    staged.write_bytes(b"old")
    first = storage.save_file(tmp_path, staged, "old.bin", request_id="old")
    for n in range(4):
        storage.save_file(
            tmp_path, bytes([n]), "new.bin", document_id=first["document_id"], request_id=f"r{n}"
        )
    calls = []
    original = storage.read_metadata

    def read(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(storage, "read_metadata", read)
    result = storage.save_file(
        tmp_path,
        b"old",
        "old.bin",
        document_id=first["document_id"],
        request_id="old",
        expected_version="v1",
    )
    assert result == first and len(calls) <= 3
    import shutil

    shutil.rmtree(tmp_path / "temp/receipts")
    assert (
        storage.save_file(
            tmp_path, b"old", "old.bin", document_id=first["document_id"], request_id="old"
        )
        == first
    )
    assert len(storage.list_versions(tmp_path, first["document_id"])) == 5
    storage.delete_document(tmp_path, first["document_id"], "v5")
    with pytest.raises(storage.VersionConflict, match="deleted"):
        storage.save_file(
            tmp_path, b"old", "old.bin", document_id=first["document_id"], request_id="old"
        )


def test_retry_policy_survives_restart_and_new_heads(tmp_path):
    meta = {"document_id": "d", "version": "v1"}
    first = retry.failed(tmp_path, meta, "outage", now=0)
    second = retry.failed(tmp_path, meta, "outage", now=30)
    assert first["next_retry"] == 30 and second["next_retry"] == 90
    assert not retry.due(tmp_path, meta, now=60)
    assert retry.due(tmp_path, meta, now=90)
    retry.failed(tmp_path, meta, "bad file", permanent=True, now=90)
    assert not retry.due(tmp_path, meta, now=10000)
    assert retry.due(tmp_path, {**meta, "version": "v2"}, now=91)
    retry.clear(tmp_path, "d")
    assert retry.due(tmp_path, meta, now=91)


def test_identical_preview_jobs_share_work_and_queue_is_bounded():
    jobs = PreviewJobs(workers=1, capacity=2)
    entered, release = threading.Event(), threading.Event()
    calls = []

    def render():
        calls.append(1)
        entered.set()
        assert release.wait(3)
        return "image"

    try:
        one = jobs.submit("same", render)
        assert entered.wait(2)
        assert jobs.submit("same", render) is one
        two = jobs.submit("other", render)
        with pytest.raises(PreviewBusy):
            jobs.submit("full", render)
        release.set()
        assert one.result() == two.result() == "image"
        assert calls == [1, 1]
        failed = jobs.submit("failed", lambda: 1 / 0)
        with pytest.raises(ZeroDivisionError):
            failed.result()
        assert jobs.submit("failed", lambda: 3).result() == 3
    finally:
        release.set()
        jobs.shutdown()


def test_manual_readers_cannot_mutate_shared_snapshot(tmp_path):
    organization_edits.atomic(
        organization_edits.path(tmp_path),
        {"schema": 1, "assignments": {"d": {"folder": "Atlas"}}, "revision": "r1"},
    )
    value = organization_edits.override(tmp_path, "d")
    value["folder"] = "bad"
    assert organization_edits.override(tmp_path, "d")["folder"] == "Atlas"
    assert organization_edits.assignment_ids(tmp_path) == frozenset({"d"})
    assert organization_edits.summary(tmp_path) == {"revision": "r1"}
    organization_edits.clear(tmp_path, ["d"])
    assert not organization_edits.assignment_ids(tmp_path)
    assert len(organization_edits._SNAPSHOTS) <= 4


def test_incomplete_arrow_spool_never_publishes(tmp_path):
    meta = storage.save_file(tmp_path, b"cat", "cat.txt")
    search.mark_pending(tmp_path, meta)
    schema = search.chunk_schema(3)
    import pyarrow as pa

    columns = ["chunk_id", "text", "basis", "provenance_json", "vector"]
    first = pa.Table.from_pylist(
        [
            {
                "chunk_id": "d:v1:t0",
                "text": "cat",
                "basis": "text",
                "provenance_json": "{}",
                "vector": [1.0, 0.0, 0.1],
            }
        ],
        schema=pa.schema([schema.field(k) for k in columns]),
    )

    class Interrupted:
        schema = first.schema

        def __iter__(self):
            yield first
            raise RuntimeError("interrupted")

    with pytest.raises(RuntimeError):
        search.put_chunks(tmp_path, meta, Interrupted(), "test-only-fixture")
    assert search._table(tmp_path, "chunks").count_rows("active = true") == 0
    assert search.find_documents(tmp_path, "cat", mode="keyword") == []


def test_generation_recovery_does_no_work_on_clean_second_start(tmp_path, monkeypatch):
    from symbiknow.organization import store as organization_store
    meta = storage.save_file(tmp_path, b"cat", "cat.txt")
    ingest.index_document(tmp_path, meta, b"cat", FixtureEmbedder())
    organization_store.recover(tmp_path)
    before = organization_store.manifest(tmp_path)
    monkeypatch.setattr(search, "_db", lambda *args: pytest.fail("clean recovery opened Lance"))
    organization_store.recover(tmp_path)
    assert organization_store.manifest(tmp_path) == before


def test_summary_and_history_are_lazy_and_history_head_is_stable(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    first = storage.save_file(tmp_path, b"v1", "one.txt")
    storage.save_file(tmp_path, b"v2", "two.txt", document_id=first["document_id"])
    monkeypatch.setattr(storage, "list_versions", lambda *args: pytest.fail("eager history"))
    monkeypatch.setattr("symbiknow.library.service.document_evidence", lambda *args: pytest.fail("eager evidence"))
    result = ui.detail(first["document_id"], section="summary")
    assert len(result["versions"]) == 1 and result["evidence"] == []
    page = storage.version_page(tmp_path, first["document_id"], limit=1)
    storage.save_file(tmp_path, b"v3", "three.txt", document_id=first["document_id"])
    older = storage.version_page(
        tmp_path, first["document_id"], offset=1, limit=1, head=page["head"]
    )
    assert older["versions"][0]["version"] == "v1"


def test_multiframe_pixels_are_closed_after_each_iteration():
    output = BytesIO()
    frames = [Image.new("RGB", (32, 32), c) for c in ["red", "blue", "green"]]
    frames[0].save(output, "TIFF", save_all=True, append_images=frames[1:])
    units = ingest.VisualUnits(output.getvalue(), image=True)
    iterator = iter(units)
    previous = next(iterator)["image"]
    assert next(iterator)["page"] == 2
    with pytest.raises(ValueError):
        previous.getpixel((0, 0))
    iterator.close()
    assert len(units) == 3


def test_byte_cache_limits_and_replacement_accounting():
    from symbiknow.core.cache import ByteLRU

    cache = ByteLRU(max_entries=5, max_bytes=4000)
    for i in range(10):
        cache[str(i)] = {"text": "x" * 1000}
    assert cache.bytes <= 4000 and len(cache) < 5
    key = next(iter(cache))
    cache[key] = {"text": "small"}
    assert cache.bytes <= 4000
    cache.clear()
    assert cache.bytes == 0
    cache["oversized"] = {"text": "x" * 5000}
    assert not cache and cache.bytes == 0


@pytest.mark.asyncio
async def test_cancelled_preview_waiter_keeps_shared_work_and_capacity():
    import asyncio

    jobs = PreviewJobs(workers=1, capacity=1)
    entered, release = threading.Event(), threading.Event()

    def render():
        entered.set()
        assert release.wait(3)
        return b"image"

    try:
        first = asyncio.create_task(jobs.wait("page", render))
        assert await asyncio.to_thread(entered.wait, 2)
        second = asyncio.create_task(jobs.wait("page", render))
        await asyncio.sleep(0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        with pytest.raises(PreviewBusy):
            jobs.submit("another-page", render)
        release.set()
        assert await second == b"image"
    finally:
        release.set()
        jobs.shutdown()


def test_concurrent_real_thumbnails_render_once(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    image = BytesIO()
    Image.new("RGB", (64, 64), "red").save(image, "PNG")
    meta = storage.save_file(tmp_path, image.getvalue(), "red.png", mime_type="image/png")
    original = ui._thumbnail
    entered, release = threading.Event(), threading.Event()
    calls = []

    def render(*args):
        calls.append(1)
        entered.set()
        assert release.wait(3)
        return original(*args)

    monkeypatch.setattr(ui, "_thumbnail", render)
    with ThreadPoolExecutor(4) as pool:
        futures = [pool.submit(ui.thumbnail, meta["document_id"], "v1") for _ in range(4)]
        assert entered.wait(2)
        time.sleep(0.05)
        release.set()
        bodies = [future.result().body for future in futures]
    assert calls == [1]
    assert all(body == bodies[0] for body in bodies)
    assert not storage._TRANSFER_ACTIVE


def test_partial_receipt_lookup_loss_cannot_create_duplicate_version(tmp_path):
    first = storage.save_file(tmp_path, b"old", "one.txt", request_id="old")
    storage.save_file(tmp_path, b"new", "two.txt", document_id=first["document_id"])
    import hashlib

    key = hashlib.sha256(b"old").hexdigest()
    (tmp_path / "temp/receipts" / first["document_id"] / (key + ".json")).unlink()
    assert (
        storage.save_file(
            tmp_path, b"old", "one.txt", document_id=first["document_id"], request_id="old"
        )
        == first
    )
    assert len(storage.list_versions(tmp_path, first["document_id"])) == 2
