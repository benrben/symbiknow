"""Expire only abandoned upload bytes and keep restart/retry guarantees."""
import base64
import hashlib
import json
import os
import time
import uuid

from symbiknow.core.application import ApplicationContext, ApplicationSettings
from symbiknow.transfers import staging
from symbiknow.library import storage


def chunk(identity, content=b"ab", offset=0, final=False):
    return {"filename": "partial.txt", "request_id": identity,
            "content_base64": base64.b64encode(content).decode(),
            "offset": offset, "total_size": 4, "sha256": hashlib.sha256(b"abcd").hexdigest(), "final": final}


def age(root, identity):
    old = time.time() - staging.IDLE_SECONDS - 1
    for suffix in (".json", ".part"):
        os.utime(root / "temp" / (identity + suffix), (old, old))


def test_expiry_preserves_durable_records_and_can_restart_same_request(tmp_path):
    context = ApplicationContext(tmp_path, settings=ApplicationSettings(storage_only=True))
    identity = str(uuid.uuid4())
    assert context.transfers.upload([chunk(identity)])["files"][0]["received_bytes"] == 2
    durable = tmp_path / "temp" / "manual-organization.json"
    durable.write_text('{"schema": 1, "assignments": {}}')
    age(tmp_path, identity)
    assert context.transfers.cleanup_staging() == 1
    assert durable.read_text() == '{"schema": 1, "assignments": {}}'
    manifest = tmp_path / "temp" / (identity + ".json")
    assert json.loads(manifest.read_text())["expired"]
    resumed = context.transfers.upload([chunk(identity, b"cd", 2, True)])["files"][0]
    assert "restart at offset 0" in resumed["error"]
    assert context.transfers.upload([chunk(identity)])["files"][0]["received_bytes"] == 2
    saved = context.transfers.upload([chunk(identity, b"cd", 2, True)])["files"][0]
    assert saved["stored"], saved
    assert manifest.exists() and json.loads(manifest.read_text())["result"]["document_id"] == saved["document_id"]


def test_pending_commit_protected_and_byte_budget_includes_other_uploads(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path, settings=ApplicationSettings(storage_only=True, max_chunk_bytes=4, max_file_bytes=4))
    identity = str(uuid.uuid4())
    monkeypatch.setattr(staging, "MAX_STAGED_BYTES", 4)
    saved = context.transfers.upload([chunk(identity, b"abcd", final=True)], background=True)["files"][0]
    assert saved["job_id"]
    age(tmp_path, identity)
    assert context.transfers.cleanup_staging() == 0
    overflow = context.transfers.upload([chunk(str(uuid.uuid4()))])["files"][0]
    assert "staging is full" in overflow["error"]
    assert context.jobs.process_one()
    assert context.jobs.get(saved["job_id"])["status"] == "completed"
    assert context.transfers.upload([chunk(str(uuid.uuid4()))])["files"][0]["received_bytes"] == 2


def test_identical_retry_refreshes_expiry_and_count_is_bounded(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path)
    identity = str(uuid.uuid4())
    monkeypatch.setattr(staging, "MAX_STAGED_FILES", 1)
    assert context.transfers.upload([chunk(identity)])["files"][0]["received_bytes"] == 2
    assert context.transfers.upload([chunk(identity)])["files"][0]["received_bytes"] == 2
    assert "Too many unfinished uploads" in context.transfers.upload([chunk(str(uuid.uuid4()))])["files"][0]["error"]
    assert context.transfers.cleanup_staging() == 0


def test_delete_purges_partial_updates_and_rejects_more_chunks(tmp_path):
    context = ApplicationContext(tmp_path, settings=ApplicationSettings(storage_only=True))
    original = storage.save_file(tmp_path, b"original", "partial.txt")
    identity = str(uuid.uuid4())
    update = dict(chunk(identity), document_id=original["document_id"], expected_version="v1")
    assert context.transfers.upload([update])["files"][0]["received_bytes"] == 2
    storage.delete_document(tmp_path, original["document_id"], "v1")
    assert not (tmp_path / "temp" / (identity + ".part")).exists()
    result = context.transfers.upload([update])["files"][0]
    assert "deleted" in result["error"]
    assert not (tmp_path / "temp" / (identity + ".part")).exists()


def test_invalid_starts_and_full_quota_do_not_leave_orphan_manifests(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path)
    for _ in range(3):
        assert "next offset 0" in context.transfers.upload([chunk(str(uuid.uuid4()), offset=1)])["files"][0]["error"]
    assert not list((tmp_path / "temp").glob("*.json"))
    monkeypatch.setattr(staging, "MAX_STAGED_FILES", 1)
    accepted = str(uuid.uuid4())
    assert context.transfers.upload([chunk(accepted)])["files"][0]["received_bytes"] == 2
    for _ in range(3):
        assert "unfinished uploads" in context.transfers.upload([chunk(str(uuid.uuid4()))])["files"][0]["error"]
    assert [p.name for p in (tmp_path / "temp").glob("*.json")] == [accepted + ".json"]
