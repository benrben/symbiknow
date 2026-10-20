"""Dependency invalidation, atomic extraction recovery and bounded worker reuse."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import sys
import threading

import pytest

from symbiknow.core.cache import ByteLRU, CacheBusy, CoalescingCache, dependency_key
from symbiknow.ingestion.conversion.manager import ConversionManager
from symbiknow.ingestion.artifacts import ExtractionArtifacts


def test_dependency_keys_canonical_and_revision_sensitive():
    assert dependency_key("a", x=1, y=[2, 3]) == dependency_key("a", y=[2, 3], x=1)
    assert dependency_key("a", x=1) != dependency_key("b", x=1)
    assert dependency_key("a", x=[1, 2]) != dependency_key("a", x=[2, 1])
    with pytest.raises(ValueError):
        dependency_key("a", x=float("nan"))


def test_lru_retains_recent_access_and_accounts_pop():
    cache = ByteLRU(max_entries=2)
    cache["a"], cache["b"] = "a", "b"
    assert cache.get("a") == "a"
    cache["c"] = "c"
    assert "b" not in cache and cache.evictions == 1
    cache.pop("a")
    assert cache.bytes == sum(cache.sizes.values())
    cache.clear()
    assert cache.bytes == 0


def test_coalesces_same_key_rejects_distinct_overflow_and_retries_failures():
    cache = CoalescingCache(max_entries=1, max_inflight=1)
    entered, release = threading.Event(), threading.Event()
    calls = []

    def compute():
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return ("immutable",)

    with ThreadPoolExecutor(3) as pool:
        first = pool.submit(cache.get_or_compute, "x", compute)
        assert entered.wait(3)
        second = pool.submit(cache.get_or_compute, "x", compute)
        with pytest.raises(CacheBusy):
            cache.get_or_compute("y", compute)
        release.set()
        assert first.result() == second.result() == ("immutable",)
    assert len(calls) == 1
    assert cache.get_or_compute("x", lambda: pytest.fail("cache miss")) == ("immutable",)
    with pytest.raises(ValueError):
        cache.get_or_compute("failed", lambda: (_ for _ in ()).throw(ValueError("failed")))
    assert cache.get_or_compute("failed", lambda: "recovered") == "recovered"
    assert len(cache.values) == 1


@pytest.mark.asyncio
async def test_cancelled_waiter_does_not_cancel_shared_work():
    cache = CoalescingCache(max_inflight=1)
    entered, release = threading.Event(), threading.Event()

    def compute():
        entered.set()
        assert release.wait(5)
        return "result"

    first = asyncio.create_task(cache.wait("x", compute))
    await asyncio.to_thread(entered.wait, 3)
    second = asyncio.create_task(cache.wait("x", compute))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    assert await second == "result"
    assert cache.stats()["computations"] == 1
    cache.close()


def _doc():
    from docling_core.types.doc import DocItemLabel, DoclingDocument

    document = DoclingDocument(name="example.md")
    document.add_text(label=DocItemLabel.PARAGRAPH, text="Exact original evidence")
    return document


def _meta():
    return dict(filename="example.md", version="v1", mime_type="text/markdown")


def test_artifacts_preserve_structure_and_recover_interrupted_or_corrupt_writes(tmp_path):
    artifacts = ExtractionArtifacts(tmp_path)
    expected = _doc()
    first, _ = artifacts.document(_meta(), "source", lambda: (expected, []))
    target = next(artifacts.root.glob("*.json"))
    (artifacts.root / ".stage-interrupted").write_text("incomplete")
    second, _ = artifacts.document(_meta(), "source", lambda: pytest.fail("duplicate extraction"))
    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert not list(artifacts.root.glob(".stage-*"))
    target.write_text('{"document":')
    recovered, _ = artifacts.document(_meta(), "source", lambda: (expected, []))
    assert recovered.model_dump(mode="json") == first.model_dump(mode="json")
    assert artifacts.hits == 1 and artifacts.misses == 2


def test_artifact_dependencies_include_source_configuration_and_library(tmp_path, monkeypatch):
    artifacts = ExtractionArtifacts(tmp_path)
    original = artifacts.key(_meta(), "source")
    assert original != artifacts.key(_meta(), "changed-source")
    assert original != artifacts.key(dict(_meta(), version="v2"), "source")
    assert original != ExtractionArtifacts(tmp_path / "other").key(_meta(), "source")
    monkeypatch.setenv("SYMBIKNOW_MAX_PAGES", "23")
    assert original != artifacts.key(_meta(), "source")


def test_artifact_retention_is_bounded_and_never_caches_partial_results(tmp_path):
    artifacts = ExtractionArtifacts(tmp_path, max_entries=1)
    calls = []

    def partial():
        calls.append(1)
        return _doc(), ["Docling reported partial conversion"]

    artifacts.document(_meta(), "partial", partial)
    artifacts.document(_meta(), "partial", partial)
    assert len(calls) == 2 and not list(artifacts.root.glob("*.json"))
    artifacts.document(_meta(), "a", lambda: (_doc(), []))
    artifacts.document(_meta(), "b", lambda: (_doc(), []))
    assert len(list(artifacts.root.glob("*.json"))) == 1
    artifacts.max_bytes = 1
    artifacts.document(_meta(), "c", lambda: (_doc(), []))
    assert not list(artifacts.root.glob("*.json"))


# A protocol fixture exercises real process death/deadline/reuse without loading OCR.
WORKER = '''
import json, os, sys, time
for line in sys.stdin:
    job = json.loads(line)
    if job['filename'] == 'crash': os._exit(2)
    if job['filename'] == 'hang': time.sleep(10)
    result = dict(id=job['id'], partial=False, rss_bytes=10, pid=os.getpid())
    if job['filename'] == 'bad': result.update(error='ValueError', permanent=True)
    print(json.dumps(result), flush=True)
'''


def _manager(**kwargs):
    return ConversionManager(command=[sys.executable, "-u", "-c", WORKER], **kwargs)


def test_worker_reuse_recycle_and_recovery(tmp_path):
    manager = _manager(max_jobs=2)
    try:
        first = manager.convert("source", tmp_path, "one")
        second = manager.convert("source", tmp_path, "two")
        third = manager.convert("source", tmp_path, "three")
        assert first["pid"] == second["pid"] != third["pid"]
        with pytest.raises(ValueError, match="original is safe"):
            manager.convert("source", tmp_path, "bad")
        after_failure = manager.convert("source", tmp_path, "four")
        assert after_failure["pid"] != third["pid"]
        with pytest.raises(RuntimeError, match="exited"):
            manager.convert("source", tmp_path, "crash")
        assert manager.convert("source", tmp_path, "recovered")["partial"] is False
    finally:
        manager.close()
    assert manager.process is None


def test_worker_heavy_releases_before_return_and_deadline_recovers(tmp_path):
    manager = _manager(timeout=.1)
    try:
        manager.convert("source", tmp_path, "heavy", heavy=True)
        assert not manager.stats()["alive"]
        with pytest.raises(TimeoutError, match="deadline exceeded"):
            manager.convert("source", tmp_path, "hang")
        assert not manager.stats()["alive"]
        assert manager.convert("source", tmp_path, "recovered")["partial"] is False
    finally:
        manager.close()


def test_worker_rss_limit_and_bounded_queue(tmp_path):
    from symbiknow.ingestion.conversion.manager import ConversionBusy

    manager = _manager(max_rss_bytes=5, capacity=1)
    try:
        manager.convert("source", tmp_path, "one")
        assert not manager.stats()["alive"]
        assert manager.slots.acquire(blocking=False)
        try:
            with pytest.raises(ConversionBusy):
                manager.convert("source", tmp_path, "two")
        finally:
            manager.slots.release()
    finally:
        manager.close()


def test_embedding_retry_reuses_complete_extraction_and_same_head_config_invalidates(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from docling.datamodel.base_models import ConversionStatus
    from symbiknow.ingestion import service as ingest
    from symbiknow.library import storage
    from tests.search.test_search import FixtureEmbedder

    content = b"# Source evidence\nExact original evidence"
    metadata = storage.save_file(tmp_path, content, "example.md")
    conversions = []

    class Converter:
        def convert(self, *args, **kwargs):
            conversions.append(1)
            return SimpleNamespace(status=ConversionStatus.SUCCESS, document=_doc())

    class FailedEmbedding(FixtureEmbedder):
        def embed_documents(self, *args):
            raise RuntimeError("retry this embedding")

    monkeypatch.setattr(ingest, "_converter", Converter)
    assert ingest.index_document(tmp_path, metadata, content, FailedEmbedding())["status"] == "failed"
    assert ingest.index_document(tmp_path, metadata, content, FixtureEmbedder())["status"] == "indexed"
    assert len(conversions) == 1
    monkeypatch.setenv("SYMBIKNOW_MAX_PAGES", "27")
    assert ingest.index_document(tmp_path, metadata, content, FixtureEmbedder())["status"] == "indexed"
    assert len(conversions) == 2
    assert storage.read_file(tmp_path, metadata["document_id"])[0] == content
    assert len(storage.list_versions(tmp_path, metadata["document_id"])) == 1


@pytest.mark.parametrize("kind", ["proof", "numeric"])
def test_current_judgments_coalesce_provider_work_and_isolate_results(monkeypatch, kind):
    from symbiknow.ai import jev
    from symbiknow.ai import numeric as jev_numeric
    from symbiknow.ai import proof as jev_proof
    from tests.ai.test_jev_proof import document, sdk as proof_sdk
    from tests.ai.test_jev_numeric import documents, sdk as numeric_sdk

    owner = jev_proof if kind == "proof" else jev_numeric
    monkeypatch.setattr(owner, "_CACHE", ByteLRU())
    entered, release = threading.Event(), threading.Event()
    calls = []

    def call(state, questions, client=None):
        calls.append(1)
        entered.set()
        assert release.wait(5)
        with (proof_sdk() if kind == "proof" else numeric_sdk()) as client:
            return client.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", call)
    query = "Who is the keeper?" if kind == "proof" else "How many hours does RC retain backups?"
    matches = [document()] if kind == "proof" else documents()
    with ThreadPoolExecutor(4) as pool:
        results = [pool.submit(jev.judge_matches, query, matches, cache_namespace="library")
                   for _ in range(4)]
        assert entered.wait(3)
        release.set()
        values = [future.result() for future in results]
    assert len(calls) == 1
    values[0]["matches"][0]["jev"]["supporting_chunk_ids"].clear()
    assert values[1]["matches"][0]["jev"]["supporting_chunk_ids"]


def test_artifact_valid_json_swap_and_descriptor_mismatch_recompute(tmp_path):
    import json

    artifacts = ExtractionArtifacts(tmp_path)
    artifacts.document(_meta(), "source-a", lambda: (_doc(), []))
    first = artifacts.root / f"{artifacts.key(_meta(), 'source-a')}.json"
    artifacts.document(_meta(), "source-b", lambda: (_doc(), []))
    second = artifacts.root / f"{artifacts.key(_meta(), 'source-b')}.json"
    first.write_bytes(second.read_bytes())
    calls = []

    def compute():
        calls.append(1)
        return _doc(), []

    artifacts.document(_meta(), "source-a", compute)
    assert len(calls) == 1
    record = json.loads(first.read_text())
    record["descriptor"]["converter"] = "incompatible-converter"
    first.write_text(json.dumps(record))
    artifacts.document(_meta(), "source-a", compute)
    assert len(calls) == 2


def test_cache_shutdown_releases_retention_and_rejects_new_work():
    cache = CoalescingCache()
    assert cache.get_or_compute("x", lambda: "retained") == "retained"
    cache.close()
    assert cache.values.bytes == 0
    with pytest.raises(RuntimeError, match="closed"):
        cache.get_or_compute("x", lambda: pytest.fail("closed cache ran work"))


def test_source_deletion_does_not_wait_for_ocr_or_publish_plaintext_in_either_library(tmp_path):
    from symbiknow.library import storage

    left, right = tmp_path / "left", tmp_path / "right"
    metadata = storage.save_file(left, b"original", "example.md")
    other = storage.save_file(right, b"original", "example.md", document_id=metadata["document_id"])
    artifacts, unrelated = ExtractionArtifacts(left), ExtractionArtifacts(right)
    unrelated.document(other, other["sha256"], lambda: (_doc(), []))
    entered, release = threading.Event(), threading.Event()

    def converting():
        entered.set()
        assert release.wait(5)
        return _doc(), []

    with ThreadPoolExecutor(1) as pool:
        pending = pool.submit(artifacts.document, metadata, metadata["sha256"], converting)
        assert entered.wait(3)
        try:
            # Must finish while conversion still owns the artifact lock.
            storage.delete_document(left, metadata["document_id"], "v1")
        finally:
            release.set()
        pending.result(timeout=5)
    assert not list(artifacts.root.glob("*.json"))
    assert not list(artifacts.root.glob(".stage-*"))
    assert len(list(unrelated.root.glob("*.json"))) == 1
    unrelated.document(other, other["sha256"], lambda: pytest.fail("other library artifact deleted"))
    assert storage.current_version(left, metadata["document_id"]) is None
    assert storage.current_version(right, other["document_id"]) == "v1"


def test_completed_document_artifacts_are_removed_on_deletion(tmp_path):
    from symbiknow.library import storage

    metadata = storage.save_file(tmp_path, b"original", "example.md")
    artifacts = ExtractionArtifacts(tmp_path)
    artifacts.document(metadata, metadata["sha256"], lambda: (_doc(), []))
    assert len(list(artifacts.root.glob("*.json"))) == 1
    storage.delete_document(tmp_path, metadata["document_id"], "v1")
    assert not list(artifacts.root.glob("*.json"))


def test_delete_orders_after_atomic_artifact_publication_and_discards_it(tmp_path, monkeypatch):
    from pathlib import Path
    from symbiknow.library import storage

    metadata = storage.save_file(tmp_path, b"original", "example.md")
    artifacts = ExtractionArtifacts(tmp_path)
    publishing, release, deleted = threading.Event(), threading.Event(), threading.Event()
    replace = Path.replace

    def pause(path, target):
        if path.name.startswith(".stage-") and Path(target).parent == artifacts.root:
            publishing.set()
            assert release.wait(5)
        return replace(path, target)

    monkeypatch.setattr(Path, "replace", pause)

    def delete():
        storage.delete_document(tmp_path, metadata["document_id"], "v1")
        deleted.set()

    with ThreadPoolExecutor(2) as pool:
        extraction = pool.submit(artifacts.document, metadata, metadata["sha256"], lambda: (_doc(), []))
        assert publishing.wait(3)
        deletion = pool.submit(delete)
        try:
            assert not deleted.wait(.05)
        finally:
            release.set()
        extraction.result(timeout=5)
        deletion.result(timeout=5)
    assert deleted.is_set() and not list(artifacts.root.glob("*.json"))


def test_cache_hit_never_recreates_artifact_deleted_after_read(tmp_path, monkeypatch):
    from symbiknow.ingestion import artifacts as extraction_artifacts
    from symbiknow.library import storage

    metadata = storage.save_file(tmp_path, b"original", "example.md")
    artifacts = ExtractionArtifacts(tmp_path)
    artifacts.document(metadata, metadata["sha256"], lambda: (_doc(), []))
    utime = extraction_artifacts.os.utime

    def deleted_before_retention_touch(path, *args, **kwargs):
        storage.delete_document(tmp_path, metadata["document_id"], "v1")
        return utime(path, *args, **kwargs)

    monkeypatch.setattr(extraction_artifacts.os, "utime", deleted_before_retention_touch)
    document, warnings = artifacts.document(metadata, metadata["sha256"], lambda: pytest.fail("reconverted hit"))
    assert document.name == "example.md" and not warnings
    assert not list(artifacts.root.glob("*.json"))
