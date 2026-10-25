"""Stopped-owner restore and deletion privacy drills on disposable libraries."""
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import shutil
import sqlite3
import threading
import uuid

import pytest

from symbiknow.core.application import ApplicationContext
from symbiknow.core.work import WorkStore
from symbiknow.freshness.store import FreshnessStore
from symbiknow.library import storage
from symbiknow.organization import edits, readmodel, receipts
from symbiknow.search import index
from symbiknow.transfers import exports, folders


def saved(context, content=b"private source canary 734921", folder="Project"):
    meta = storage.save_file(context.DATA_DIR, content, "private.txt")
    index.register_document(context.DATA_DIR, meta)
    edits.edit("move-documents", {"folder": folder, "documents": [
        {"document_id": meta["document_id"], "expected_version": meta["version"]}
    ]}, context)
    return meta


def remove(context, meta):
    context.library.delete_item("delete-document", {
        "document_id": meta["document_id"], "expected_version": meta["version"]})


@pytest.mark.parametrize("legacy_action", ["replace", "remove"])
def test_migration_never_replays_legacy_after_sql_edits_or_copy(tmp_path, legacy_action):
    source, restored = tmp_path / "source", tmp_path / "restored"
    legacy = edits.path(source)
    edits.atomic(legacy, {"schema": 1, "assignments": {"one": {"folder": "Old"}}})
    edits.recover(source)
    with edits._database(source) as db:
        db.execute("UPDATE assignments SET payload=? WHERE id='one'", (json.dumps({"folder": "New"}),))
    if legacy_action == "replace":
        edits.atomic(legacy, {"schema": 1, "assignments": {"one": {"folder": "Stale"}}})
    else:
        legacy.unlink()
    shutil.copytree(source, restored)
    for root in (source, restored):
        edits.recover(root)
        assert edits.override(root, "one") == {"folder": "New"}
        edits.clear(root, ["one"])
        edits.recover(root)
        assert edits.override(root, "one") is None


def test_failed_migration_rolls_back_marker_and_assignments(tmp_path):
    edits.atomic(edits.path(tmp_path), {"schema": 1, "assignments": {"one": {"folder": "Old"}}})
    with pytest.raises(RuntimeError):
        with edits._database(tmp_path):
            raise RuntimeError("interrupted before commit")
    with sqlite3.connect(edits.path(tmp_path).with_suffix(".sqlite3")) as db:
        assert not db.execute("SELECT 1 FROM metadata WHERE key='legacy'").fetchone()
        assert not db.execute("SELECT 1 FROM assignments").fetchone()
    edits.recover(tmp_path)
    assert edits.override(tmp_path, "one")["folder"] == "Old"


@pytest.mark.parametrize("legacy_paths", [False, True])
def test_stopped_library_restore_preserves_versions_and_all_durable_databases(tmp_path, legacy_paths):
    source, restored = tmp_path / "source", tmp_path / "restored"
    context = ApplicationContext(source)
    # Migrate a legacy assignment, then make a newer authoritative edit.
    edits.atomic(edits.path(source), {"schema": 1, "assignments": {"one": {"folder": "Old"}}})
    meta = saved(context, b"historical source")
    newest = storage.save_file(source, b"current source", "private.txt", document_id=meta["document_id"], expected_version="v1")
    index.register_document(source, newest)
    readmodel.initialize(source)
    receipt = {"id": "manual-decision", "scope": "scope", "action": "skip"}
    receipts.save(source, receipt)
    with FreshnessStore(source).connection(create=True) as db:
        db.execute("INSERT INTO reviews VALUES('scan','finding',1,?)", (json.dumps({"note": "Human review"}),))
    queued = context.jobs.start("original-range", {"item": {"document_id": meta["document_id"], "version": "v1"}})
    context.work.claim("jobs")  # Simulate a stopped owner with an unacknowledged lease.
    if legacy_paths:
        with storage._range_db(source) as db:
            for version in ("v1", "v2"):
                db.execute("UPDATE files SET path=? WHERE id=? AND version=?", (
                    str(storage._original_path(source, meta["document_id"], version)), meta["document_id"], version))
    storage.close_readers()
    shutil.copytree(source, restored)
    # Keep the old path present but change its bytes, proving reads use the copy.
    storage._original_path(source, meta["document_id"], "v1").write_bytes(b"wrong old root bytes")
    recovered = ApplicationContext(restored)
    recovered.work.recover()
    storage.recover_deletions(restored)
    edits.recover(restored)
    readmodel.initialize(restored)
    for version, expected in (("v1", b"historical source"), ("v2", b"current source")):
        storage.prepare_ranges(restored, meta["document_id"], version)
        with storage.verified_ranges(restored, meta["document_id"], version) as (reader, _):
            assert reader.read(0, 100) == expected
        assert storage.read_file(restored, meta["document_id"], version)[0] == expected
    assert [row["version"] for row in storage.list_versions(restored, meta["document_id"])] == ["v1", "v2"]
    assert edits.override(restored, meta["document_id"])["folder"] == "Project"
    assert receipts.get(restored, "manual-decision") == receipt
    with FreshnessStore(restored).connection() as db:
        assert json.loads(db.execute("SELECT payload FROM reviews").fetchone()[0])["note"] == "Human review"
    assert recovered.jobs.process_one()
    result = recovered.jobs.get(queued["job_id"])
    assert result["status"] == "completed"
    assert base64.b64decode(result["result"]["content_base64"]) == b"historical source"
    paths = list(restored.rglob("*.sqlite3"))
    assert {p.name for p in paths} >= {"manual-organization.sqlite3", "original-ranges.sqlite3", "work.sqlite3", "jev-decisions.sqlite3", "reviews.sqlite3"}
    for file in paths:
        with sqlite3.connect(file) as db:
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_delete_purges_original_download_answer_and_both_export_copies(tmp_path):
    context = ApplicationContext(tmp_path)
    meta = saved(context)
    identity = meta["document_id"]
    token = str(uuid.uuid4())
    exports.prepare(context, [{"document_id": identity, "version": "v1"}], token)
    job_ids = []
    for kind, args in (("original-range", {"item": {"document_id": identity, "version": "v1"}}),
                       ("folder-export", {"folder": "Project"})):
        job = context.jobs.start(kind, args)
        job_ids.append(job["job_id"])
        context.jobs.process_one()
        assert context.jobs.get(job["job_id"])["status"] == "completed"
    folder_result = context.jobs.get(job_ids[1])["result"]
    search = context.jobs.start("ask", {"query": "private source"})
    item = context.work.claim("jobs")[0]
    context.work.finish(item, {"matches": [{"document_id": identity, "text": "private source canary 734921"}],
                               "answer": {"text": "private source canary 734921"}})
    job_ids.append(search["job_id"])
    remove(context, meta)
    remove(context, meta)  # Retried deletes cannot skip unfinished retention cleanup.
    for job_id in job_ids:
        result = ApplicationContext(tmp_path).jobs.get(job_id)
        assert result["status"] == "failed" and result["result"] is None
    with pytest.raises(FileNotFoundError):
        exports.path(context, token)
    with pytest.raises(ValueError):
        folders.download_folder("Project", folder_result["transfer_id"], context=context)
    for directory in ("selection-exports", "folder-exports"):
        assert not list((tmp_path / "temp" / directory).glob("*.zip"))
    with storage._range_db(tmp_path) as db:
        assert not db.execute("SELECT 1 FROM files WHERE id=?", (identity,)).fetchone()
        assert not db.execute("SELECT 1 FROM blocks WHERE id=?", (identity,)).fetchone()
    assert b"private source canary 734921" not in context.work.path.read_bytes()


def test_deleted_sources_reject_late_progress_and_completion_after_restart(tmp_path):
    queue = WorkStore(tmp_path)
    queue.start("ask", {"query": "question"}, "answer")
    item = queue.claim("jobs")[0]
    queue.track_sources(item, ["source"])
    queue.progress(item, {"matches": [{"document_id": "source", "text": "sensitive"}]})
    queue.purge_document("source")
    restarted = WorkStore(tmp_path)
    restarted.recover()
    restarted.progress(item, {"answer": {"text": "sensitive"}})
    restarted.finish(item, {"answer": {"text": "sensitive"}})
    assert restarted.get("jobs", "answer")["result"] is None
    # Also reject an old worker that had not yet published its first dependency.
    restarted.start("ask", {"query": "another"}, "late")
    late = restarted.claim("jobs")[0]
    restarted.finish(late, {"matches": [{"document_id": "source", "text": "sensitive"}]})
    assert restarted.get("jobs", "late")["state"] == "failed"
    assert restarted.get("jobs", "late")["result"] is None


@pytest.mark.parametrize("kind", ["selection", "folder"])
def test_export_publication_race_cannot_retain_deleted_source(tmp_path, monkeypatch, kind):
    context = ApplicationContext(tmp_path)
    meta = saved(context)
    entered, release = threading.Event(), threading.Event()
    original = storage._RangeReader.read

    def pause(reader, offset, length):
        content = original(reader, offset, length)
        entered.set()
        assert release.wait(5)
        return content

    monkeypatch.setattr(storage._RangeReader, "read", pause)
    with ThreadPoolExecutor(max_workers=1) as pool:
        if kind == "selection":
            future = pool.submit(exports.prepare, context, [{"document_id": meta["document_id"], "version": "v1"}], str(uuid.uuid4()))
        else:
            future = pool.submit(folders.download_folder, "Project", context=context)
        assert entered.wait(5)
        try:
            remove(context, meta)
        finally:
            release.set()
        with pytest.raises(FileNotFoundError):
            future.result(timeout=5)
    for directory in ("selection-exports", "folder-exports"):
        assert not list((tmp_path / "temp" / directory).glob("*.zip"))
        assert not list((tmp_path / "temp" / directory).glob("*.tmp"))


def test_recovery_scrubs_old_completed_deletion_receipts(tmp_path):
    context = ApplicationContext(tmp_path)
    meta = saved(context)
    token = str(uuid.uuid4())
    exports.prepare(context, [{"document_id": meta["document_id"], "version": "v1"}], token)
    job = context.jobs.start("original-range", {"item": {"document_id": meta["document_id"], "version": "v1"}})
    context.jobs.process_one()
    # Reproduce a deletion made by the older release that only removed originals/index.
    storage._run(tmp_path, "purge", "--force", meta["document_id"])
    edits.atomic(storage._deletion_path(tmp_path, meta["document_id"]), {
        "document_id": meta["document_id"], "version": "v1", "derived_removed": True})
    storage.recover_deletions(tmp_path)
    assert context.jobs.get(job["job_id"])["result"] is None
    assert not (tmp_path / "temp" / "selection-exports" / (token + ".zip")).exists()


def test_expiry_removes_both_archives_without_a_new_export(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path)
    saved(context)
    folder = folders.download_folder("Project", context=context)
    # Startup/periodic cleanup uses the absolute expiry, not access timestamps.
    monkeypatch.setattr(exports.time, "time", lambda: folder["expires_at"] + 1)
    exports.cleanup(tmp_path)
    assert not list((tmp_path / "temp" / "folder-exports").glob("*.zip"))


@pytest.mark.parametrize("explicit_update", [False, True])
def test_deletion_removes_queued_folder_payload_and_rejects_byte_replay(tmp_path, explicit_update):
    context = ApplicationContext(tmp_path)
    payload = {"folder": "Project", "request_id": str(uuid.uuid4()), "files": [{
        "relative_path": "private.txt", "content_base64": base64.b64encode(b"private bytes").decode()}]}
    if explicit_update:
        meta = saved(context, b"private bytes")
        payload["files"][0].update(document_id=meta["document_id"], expected_version="v1")
    else:
        meta = folders.upload_folder(**payload, context=context)["files"][0]
    input_id = "a" * 64
    file = folders.staged_input(tmp_path, input_id)
    edits.atomic(file, payload)
    job = context.jobs.start("folder-upload", {"input": input_id})
    remove(context, meta)
    assert not file.exists()
    assert context.jobs.get(job["job_id"])["status"] == "failed"
    edits.atomic(file, payload)  # A retried adapter may stage before queue admission.
    with pytest.raises(ValueError, match="deleted"):
        context.jobs.start("folder-upload", {"input": input_id}, job["job_id"])
    assert not file.exists()
    assert not context.jobs.process_one()
    assert storage.current_version(tmp_path, meta["document_id"]) is None


def test_stale_worker_cannot_attach_dependencies_to_replacement_generation(tmp_path):
    queue = WorkStore(tmp_path)
    queue.start("search", {"query": "old"}, "query")
    old = queue.claim("jobs")[0]
    queue.enqueue("jobs", "query", {"kind": "search", "args": {"query": "new"}}, replace=True)
    queue.finish(old, {"matches": [{"document_id": "old-source"}]})
    queue.purge_document("old-source")
    current = queue.claim("jobs")[0]
    queue.finish(current, {"matches": [{"document_id": "new-source"}]})
    assert queue.get("jobs", "query")["state"] == "completed"


def test_range_preparation_cannot_publish_after_deletion(tmp_path):
    from io import BytesIO
    from types import SimpleNamespace

    meta = storage.save_file(tmp_path, b"private original", "private.txt")
    with storage._range_db(tmp_path) as db:
        db.execute("DELETE FROM files")

    class DeletingReader(BytesIO):
        deleted = False

        def read(self, size=-1):
            if not self.deleted:
                self.deleted = True
                storage.delete_document(tmp_path, meta["document_id"], "v1")
            return super().read(size)

    source = SimpleNamespace(open=lambda mode: DeletingReader(b"private original"))
    with pytest.raises(FileNotFoundError):
        storage.prepare_ranges(tmp_path, meta["document_id"], source=source)
    with storage._range_db(tmp_path) as db:
        assert not db.execute("SELECT 1 FROM files").fetchone()
        assert not db.execute("SELECT 1 FROM blocks").fetchone()


def test_restart_redacts_legacy_zip_jobs_without_source_manifests(tmp_path):
    queue = WorkStore(tmp_path)
    queue.start("folder-export", {"folder": "Project"}, "old-zip")
    item = queue.claim("jobs")[0]
    queue.finish(item, {"transfer_id": str(uuid.uuid4()), "content_base64": base64.b64encode(b"unattributable private zip").decode()})
    queue.recover()
    assert queue.get("jobs", "old-zip")["state"] == "failed"
    assert queue.get("jobs", "old-zip")["result"] is None


def test_concurrent_first_migration_commits_once(tmp_path):
    edits.atomic(edits.path(tmp_path), {"schema": 1, "assignments": {"one": {"folder": "Manual"}}})
    barrier = threading.Barrier(6)

    def read():
        barrier.wait(timeout=5)
        return edits.override(tmp_path, "one")

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: read(), range(6)))
    assert results == [{"folder": "Manual"}] * 6


def test_expired_folder_job_does_not_replay_zip_bytes(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path)
    saved(context)
    job = context.jobs.start("folder-export", {"folder": "Project"})
    context.jobs.process_one()
    result = context.jobs.get(job["job_id"])["result"]
    monkeypatch.setattr(exports.time, "time", lambda: result["expires_at"] + 1)
    expired = context.jobs.get(job["job_id"])
    assert expired["status"] == "failed" and expired["result"] is None


def test_folder_payload_expiry_protects_pending_jobs_and_durable_receipts(tmp_path):
    import os
    import time

    context = ApplicationContext(tmp_path)
    now = time.time()
    payload = {"folder": "Project", "request_id": str(uuid.uuid4()), "files": [{
        "relative_path": "private.txt", "content_base64": base64.b64encode(b"private bytes").decode()}]}
    paths, jobs = {}, {}
    for number, state in enumerate(("failed", "running", "queued", "orphan", "recent")):
        identity = f"{number:064x}"
        paths[state] = folders.staged_input(tmp_path, identity)
        edits.atomic(paths[state], payload)
        if state in {"failed", "running"}:
            jobs[state] = context.jobs.start("folder-upload", {"input": identity})
            item = context.work.claim("jobs")[0]
            if state == "failed":
                context.work.finish(item, {"complete": False}, error="Retry upload")
        elif state == "queued":
            jobs[state] = context.jobs.start("folder-upload", {"input": identity})
        if state != "recent":
            os.utime(paths[state], (now - 86401, now - 86401))
    # Arbitrary durable records and links are never considered expendable input.
    durable = paths["failed"].parent / "manual-decisions.json"
    durable.write_text('{"decision":"keep"}')
    os.utime(durable, (now - 86401, now - 86401))
    assert folders.cleanup_staged(context, now=now) == 2
    assert not paths["failed"].exists() and not paths["orphan"].exists()
    assert all(paths[state].exists() for state in ("queued", "running", "recent"))
    assert durable.exists()
    assert context.jobs.get(jobs["failed"]["job_id"])["result"] == {"complete": False}
    # An exact retry restages its data and can resume using the original job ID.
    edits.atomic(paths["failed"], payload)
    assert context.jobs.start("folder-upload", {"input": paths["failed"].stem}, jobs["failed"]["job_id"])["status"] == "queued"
