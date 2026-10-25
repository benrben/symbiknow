"""Inventory reads cover originals without relying on semantic evidence."""
import json

import pytest

from symbiknow.core.application import ApplicationContext
from symbiknow.library import storage
from symbiknow.organization import edits, receipts
from symbiknow.search import index


def saved(root, name="same.txt", content=b"stored original", **options):
    return storage.save_file(root, content, name, **options)


def pages(operation, **options):
    cursor, output = None, []
    while True:
        page = operation(cursor=cursor, **options)
        output.extend(page.get("documents", page.get("items", page.get("entries", []))))
        if not page["has_more"]:
            return output
        cursor = page["next_cursor"]


def test_inventory_includes_unregistered_pending_unsupported_and_current_evidence(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path)
    originals = [saved(tmp_path, content=str(i).encode(), source="https://secret:password@example.test?token=secret") for i in range(4)]
    for original in originals[1:]:
        index.register_document(tmp_path, original)
    index.set_document_status(tmp_path, originals[2], status="unsupported", index_error="/private/provider-key: secret")
    index.put_chunks(tmp_path, originals[3], [{"chunk_id": originals[3]["document_id"] + ":t0", "text": "stored original",
                     "basis": "text", "provenance_json": "{}", "vector": [1., 0., .1]}], "fixture")
    index.set_document_status(tmp_path, originals[3], status="indexed", indexed_version="v1", searchable_text=True)
    context.catalog.prepare()
    monkeypatch.setattr(storage, "iter_documents", lambda *a, **k: pytest.fail("request must not enumerate originals"))
    monkeypatch.setattr(index, "find_documents", lambda *a, **k: pytest.fail("inventory is not semantic retrieval"))
    rows = pages(context.catalog.list_documents, limit=1)
    assert {row["document_id"] for row in rows} == {original["document_id"] for original in originals}
    assert {row["indexing_status"] for row in rows} == {"unregistered", "pending", "unsupported", "indexed"}
    assert sum(row["searchable"] for row in rows) == 1
    assert all(row["source_filename"] == "same.txt" for row in rows)
    assert "secret" not in json.dumps(rows)
    filtered = pages(context.catalog.list_documents, limit=1, status="unsupported")
    assert len(filtered) == 1 and filtered[0]["document_id"] == originals[2]["document_id"]


def test_catalog_preparation_is_background_and_retryable(tmp_path):
    context = ApplicationContext(tmp_path)
    document = saved(tmp_path)
    first = context.catalog.list_documents(limit=2)
    assert first["status"] == "queued" and not context.catalog.ready()
    assert context.jobs.process_one(kinds=["library-catalog"])
    completed = context.jobs.get(first["job_id"])
    assert completed["status"] == "completed"
    assert completed["result"]["documents"][0]["document_id"] == document["document_id"]


def test_source_commits_keep_catalog_complete_without_rescanning(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path)
    one = saved(tmp_path)
    context.catalog.prepare()
    monkeypatch.setattr(storage, "iter_documents", lambda *a, **k: pytest.fail("incremental commit should not rescan"))
    two = saved(tmp_path, content=b"another")
    current = saved(tmp_path, content=b"new version", document_id=one["document_id"], expected_version="v1")
    assert context.catalog.ready()
    rows = context.catalog.list_documents()["documents"]
    assert {row["document_id"]: row["version"] for row in rows} == {two["document_id"]: "v1", current["document_id"]: "v2"}
    context.library.delete_item("delete-document", {"document_id": two["document_id"], "expected_version": "v1"})
    assert context.catalog.ready()
    assert len(context.catalog.list_documents()["documents"]) == 1


@pytest.mark.parametrize("change", ["source", "evidence", "folder", "filter"])
def test_inventory_continuation_guards_all_authorities(tmp_path, change):
    context = ApplicationContext(tmp_path)
    one, _ = saved(tmp_path), saved(tmp_path)
    index.register_document(tmp_path, one)
    context.catalog.prepare()
    first = context.catalog.list_documents(limit=1)
    options = dict(limit=1, cursor=first["next_cursor"])
    if change == "source":
        saved(tmp_path)
    elif change == "evidence":
        index.set_document_status(tmp_path, one, status="unsupported")
    elif change == "folder":
        edits.edit("move-documents", {"folder": "Chosen", "documents": [{"document_id": one["document_id"], "expected_version": "v1"}]}, context)
    else:
        options["status"] = "pending"
    with pytest.raises(ValueError, match="restart"):
        context.catalog.list_documents(**options)


def test_taxonomy_separates_ownership_folder_and_topics(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path)
    original = saved(tmp_path)
    index.register_document(tmp_path, original)
    from symbiknow.organization.policy import project_identity
    project = project_identity("Atlas")
    index.save_organization(tmp_path, original["document_id"], "v1", dict(status="evaluated", folder="Auto", groups=["Research"],
                            canonical_project=project, links=[]))
    edits.edit("move-documents", {"folder": "Personal / Archive", "documents": [{"document_id": original["document_id"], "expected_version": "v1"}]}, context)
    context.catalog.prepare_taxonomy()
    facets = pages(context.catalog.taxonomy, limit=1)
    actual = {(item["dimension"], item["name"]): item["count"] for item in facets}
    assert actual[("projects", "Atlas")] == actual[("folders", "Personal / Archive")] == actual[("topics", "Research")] == 1
    assert context.catalog.list_documents(project=project["id"])["count"] == 1
    monkeypatch.setattr(storage, "iter_documents", lambda *a, **k: pytest.fail("organization changes do not rebuild source catalog"))
    edits.edit("move-documents", {"folder": "Elsewhere", "documents": [{"document_id": original["document_id"], "expected_version": "v1"}]}, context)
    context.catalog.prepare_taxonomy()
    assert context.catalog.taxonomy(dimension="folders")["items"][0]["name"] == "Elsewhere"


def test_history_unknown_legacy_provenance_and_bounded_receipt_pages(tmp_path):
    context = ApplicationContext(tmp_path)
    original = saved(tmp_path)
    identity = original["document_id"]
    for i in range(7):
        receipts.save(tmp_path, dict(id=f"{identity}:{i}", scope=str(i), action="skip", value=None, actor="agent"))
    # Historical imports legitimately did not store actor/date/version.
    index.register_document(tmp_path, original)
    edits.edit("move-documents", {"folder": "Manual", "documents": [{"document_id": identity, "expected_version": "v1"}]}, context)
    rows = pages(lambda **args: context.catalog.history(identity, **args), limit=2)
    assert len(rows) == 8 and len({row["id"] for row in rows}) == 8
    assert all(row["timestamp"] is None and row["version"] is None for row in rows)
    assert {row["action"] for row in rows} == {"skip", "manual-folder-override"}
    current = context.catalog.history(identity)["current"]
    assert current["folder"] == "Manual" and current["manual_folder_override"]["folder"] == "Manual"
    first = context.catalog.history(identity, limit=1)
    receipts.save(tmp_path, dict(id=f"{identity}:new", scope="new", action="skip", actor="user"))
    with pytest.raises(ValueError, match="restart"):
        context.catalog.history(identity, limit=1, cursor=first["next_cursor"])


def test_job_list_sanitized_and_state_changes_invalidate_cursor(tmp_path):
    context = ApplicationContext(tmp_path)
    context.jobs.start("preview", {"document_id": "secret-document", "query": "private contents", "path": "/private/key"})
    context.jobs.start("preview", {"document_id": "other"})
    page = context.catalog.jobs(limit=1)
    assert page["has_more"] and len(page["jobs"]) == 1
    assert not any(secret in json.dumps(page) for secret in ["secret-document", "private contents", "/private/key"])
    context.work.claim("jobs")
    with pytest.raises(ValueError, match="restart"):
        context.catalog.jobs(limit=1, cursor=page["next_cursor"])


def test_delete_erases_taxonomy_and_cached_catalog_job_results(tmp_path):
    context = ApplicationContext(tmp_path)
    original = saved(tmp_path)
    index.register_document(tmp_path, original)
    edits.edit("move-documents", {"folder": "Private project name", "documents": [
        {"document_id": original["document_id"], "expected_version": "v1"}]}, context)
    job = context.catalog.taxonomy()
    context.jobs.process_one(kinds=["library-catalog"])
    assert context.jobs.get(job["job_id"])["result"]["items"]
    receipts.save(tmp_path, dict(id=original["document_id"] + ":old", scope="old", action="skip", value="Private project name"))
    context.library.delete_item("delete-document", {"document_id": original["document_id"], "expected_version": "v1"})
    assert not context.catalog._taxonomy_path().exists()
    retained = context.jobs.get(job["job_id"])
    assert retained["status"] == "failed" and retained["result"] is None
    assert receipts.get(tmp_path, original["document_id"] + ":old") is None


def test_history_queries_seek_document_and_rowid_indexes(tmp_path):
    from symbiknow.organization import projects
    with projects._database(tmp_path) as db:
        plan = db.execute("EXPLAIN QUERY PLAN SELECT rowid,payload FROM history "
                          "WHERE json_extract(payload,'$.document_id')=? AND rowid>? ORDER BY rowid LIMIT ?", ("document", 200, 10)).fetchall()
    assert any("ownership_history_document" in row[3] and "rowid>?" in row[3] for row in plan)
    with receipts.connection(tmp_path) as db:
        plan = db.execute("EXPLAIN QUERY PLAN SELECT rowid,payload FROM receipts "
                          "WHERE substr(id,1,instr(id,':')-1)=? AND rowid>? ORDER BY rowid LIMIT ?", ("document", 200, 10)).fetchall()
    assert any("receipt_document" in row[3] and "rowid>?" in row[3] for row in plan)


def test_damaged_catalog_cannot_abort_original_commit_or_receipt(tmp_path):
    context = ApplicationContext(tmp_path)
    first = saved(tmp_path)
    context.catalog.prepare()
    (tmp_path / "temp" / "library-catalog.sqlite3").write_bytes(b"damaged rebuildable cache")
    newest = saved(tmp_path, content=b"second version", document_id=first["document_id"], expected_version="v1")
    assert newest["version"] == "v2"
    assert storage.read_file(tmp_path, newest["document_id"])[0] == b"second version"
    assert context.originals.metadata(newest["document_id"])["version"] == "v2"
    assert not context.catalog.ready()
    context.catalog.prepare()
    assert context.catalog.list_documents()["documents"][0]["version"] == "v2"


def test_stale_indexed_version_is_pending_metadata_not_searchable():
    from symbiknow.library.catalog import inventory_document
    value = inventory_document({"document_id": "d", "version": "v2", "filename": "file"},
                               {"version": "v2", "indexed_version": "v1", "status": "indexed", "searchable_text": True})
    assert value["indexing_status"] == "pending" and not value["searchable"] and not value["searchable_text"]


def test_completed_preparation_is_requeued_if_rebuildable_cache_disappears(tmp_path):
    context = ApplicationContext(tmp_path)
    saved(tmp_path)
    saved(tmp_path)
    first = context.catalog.list_documents(limit=1)
    context.jobs.process_one(kinds=["library-catalog"])
    assert context.jobs.get(first["job_id"])["status"] == "completed"
    (tmp_path / "temp" / "library-catalog.sqlite3").unlink()
    again = context.catalog.list_documents(limit=1)
    assert again["job_id"] == first["job_id"] and again["status"] == "queued"
    context.jobs.process_one(kinds=["library-catalog"])
    page = context.jobs.get(again["job_id"])["result"]
    next_page = context.catalog.list_documents(limit=1, cursor=page["next_cursor"])
    assert len(page["documents"]) == len(next_page["documents"]) == 1
    assert page["documents"][0]["document_id"] != next_page["documents"][0]["document_id"]
