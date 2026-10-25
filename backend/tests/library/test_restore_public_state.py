"""Complement structural restore drills with real reviewed freshness and completed jobs.

All originals and databases are disposable. Provider judgments are deterministic
fixtures: this tests restoration semantics, not hosted judgment/model quality.
"""
import base64
import shutil
import sqlite3

from symbiknow.core.application import ApplicationContext
from symbiknow.freshness import judgments
from symbiknow.library import storage
from symbiknow.organization import edits, readmodel
from symbiknow.search import index
from tests.search.test_search import FixtureEmbedder, _add


def test_relocated_restore_serves_reviewed_freshness_completed_jobs_and_manual_views(tmp_path, monkeypatch):
    source, restored = tmp_path / "stopped-source", tmp_path / "restored-library"
    context = ApplicationContext(source)
    embedder = FixtureEmbedder()
    monkeypatch.setattr(index, "get_embedder", lambda: embedder)
    archived_bytes = b"Archived Atlas production retention was 10 days."
    archived = storage.save_file(source, archived_bytes, "retention.txt")
    policy = _add(source, embedder, "retention.txt", b"Atlas production retention is 30 days.",
                  document_id=archived["document_id"], expected_version="v1")
    reference = _add(source, embedder, "reference.txt", b"Atlas production retention is 90 days.")
    edits.edit("move-documents", {"folder": "Manual / Retention", "documents": [
        {"document_id": doc["document_id"], "expected_version": doc["version"]}
        for doc in (policy, reference)
    ]}, context)

    monkeypatch.setattr(judgments, "classify", lambda passages, filename: {
        passage["id"]: "claim" for passage in passages})
    monkeypatch.setattr(judgments, "compare_many", lambda pairs, contexts, as_of, **callbacks: {
        pair["id"]: {"scope": "same", "relation": "incompatible"} for pair in pairs})
    scan = context.freshness.start(reference_document_ids=[reference["document_id"]], request_id="review-before-backup")
    for _ in range(100):
        if not context.freshness.process_one():
            break
    else:
        raise AssertionError("Deterministic freshness fixture did not finish")
    before = context.freshness.get(scan["scan_id"])
    assert before["scan"]["status"] == "completed", before["scan"]
    finding = before["findings"][0]
    assert finding["category"] == "possibly_outdated" and finding["validity"] == "valid"
    review = context.freshness.review(scan["scan_id"], finding["finding_id"], finding["revision"],
                                     "historical", "Retain the human applicability decision after restore")

    completed = context.jobs.start("original-range", {"item": {
        "document_id": policy["document_id"], "version": "v1", "length": 256,
    }}, "completed-before-backup")
    assert context.jobs.process_one()
    stored_job = context.jobs.get(completed["job_id"])
    assert stored_job["status"] == "completed"
    assert base64.b64decode(stored_job["result"]["content_base64"]) == archived_bytes
    before_view = context.library.library({"folder": "Manual / Retention"}).to_wire()
    assert before_view["total"] == 2

    # Work is synchronous and quiescent: no owner/worker runs during the copy.
    # Removing the source proves every restored read uses the relocated library.
    context.jobs.close()
    storage.close_readers()
    index._db.cache_clear()
    shutil.copytree(source, restored)
    shutil.rmtree(source)

    recovered = ApplicationContext(restored)
    recovered.work.recover()
    storage.recover_deletions(restored)
    edits.recover(restored)
    readmodel.initialize(restored)
    actual_job = recovered.jobs.get(completed["job_id"])
    assert actual_job == stored_job
    assert not recovered.jobs.process_one()  # A completed download is not replayed.
    assert base64.b64decode(recovered.transfers.download([{
        "document_id": policy["document_id"], "version": "v1", "length": 256,
    }])["files"][0]["content_base64"]) == archived_bytes

    page = recovered.freshness.get(scan["scan_id"])
    assert page["scan"]["status"] == "completed" and not page["scan"]["coverage_changed"]
    actual_finding = next(item for item in page["findings"] if item["finding_id"] == finding["finding_id"])
    assert actual_finding["validity"] == "valid"
    assert actual_finding["revision"] == review["revision"]
    assert actual_finding["review"] == "historical"
    assert actual_finding["review_note"] == "Retain the human applicability decision after restore"
    for evidence in actual_finding["evidence"]:
        row = index.resolve_evidence(restored, evidence["document_id"], evidence["version"], evidence["evidence_id"])
        assert row["text"][evidence["start"]:evidence["end"]] == evidence["text"]

    view = recovered.library.library({"folder": "Manual / Retention"}).to_wire()
    assert view["total"] == 2 and view["library_id"] == before_view["library_id"]
    assert {(doc["document_id"], doc["version"], doc["folder"]) for doc in view["documents"]} == {
        (doc["document_id"], doc["version"], "Manual / Retention") for doc in (policy, reference)
    }
    databases = list(restored.rglob("*.sqlite3"))
    assert {file.name for file in databases} >= {"work.sqlite3", "reviews.sqlite3", "manual-organization.sqlite3"}
    for file in databases:
        with sqlite3.connect(file) as db:
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok", file
