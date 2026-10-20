"""Explicit Reset publishes New immediately, then each reviewed authoritative row."""
import copy
import json

import pytest

from symbiknow.organization import policy as organization
from symbiknow.organization import edits as organization_edits
from symbiknow.organization import store as organization_store
from symbiknow.organization import rebuild
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.library import storage
from tests.api.test_ui_api import context as context, indexed, decision


def enable(monkeypatch):
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "fixture")


def restart(monkeypatch):
    for name in ("_SNAPSHOT", "_STAMP", "_ACTIVE_JOB", "_ACTIVE_STAMP", "_PERSISTED"):
        monkeypatch.setattr(rebuild, name, None)


def move(identity, folder):
    organization_edits.edit("move-documents", {"folder": folder, "documents": [
        {"document_id": identity, "expected_version": "v1"}]})


def test_reset_publishes_new_before_scanning_and_each_review_before_completion(context):
    root, monkeypatch, _ = context
    enable(monkeypatch)
    docs = [indexed(root, name=name) for name in ("a.txt", "b.txt", "outside.txt")]
    old, outside = organization.project_identity("Old project"), organization.project_identity("Outside project")
    for doc, folder, project in [(docs[0], "Old / A", old), (docs[1], "Old / B", old), (docs[2], "Outside", outside)]:
        search.save_organization(root, doc["document_id"], "v1", {**decision(folder), "canonical_project": project})
    move(docs[0]["document_id"], "Old / A")
    originals = [(storage.read_file(root, d["document_id"])[0], storage.list_versions(root, d["document_id"])) for d in docs]
    calls = []

    def organize(document, *args, **kwargs):
        assert search.get_document_status(root, document["document_id"])["folder"] == "New"
        assert "Old project" not in [project["name"] for project in kwargs["projects"]]
        assert "New" not in [project["name"] for project in kwargs["projects"]]
        calls.append(document["document_id"])
        return decision("Fresh / Result")

    monkeypatch.setattr("symbiknow.ai.jev.organize_document", organize)
    before = search.revisions(root)
    state = rebuild.request(folder="Old")
    assert calls == [] and state["layout_revision"] == state["request_id"]
    assert search.revisions(root) != before
    assert search.browse_documents(root, folder="Old")["total"] == 0
    assert search.browse_documents(root, folder="New")["total"] == 2
    assert organization_edits.assignment_ids(root) == frozenset()
    assert [p["name"] for p in search.project_roster(root)] == ["Outside project"]
    assert rebuild.process_one()
    assert rebuild.status()["status"] == "running"
    assert search.browse_documents(root, folder="Fresh / Result")["total"] == 1
    assert search.browse_documents(root, folder="New")["total"] == 1
    assert search.find_documents(root, "cat", mode="keyword", folder="Fresh / Result")
    stale_starter = copy.deepcopy(state)
    stale_starter["reset_started"] = False
    rebuild._start_reset(stale_starter)
    assert search.browse_documents(root, folder="Fresh / Result")["total"] == 1
    while rebuild.process_one():
        pass
    assert len(calls) == 2
    assert search.get_document_status(root, docs[2]["document_id"])["folder"] == "Outside"
    assert [(storage.read_file(root, d["document_id"])[0], storage.list_versions(root, d["document_id"])) for d in docs] == originals


@pytest.mark.parametrize("grouping,links", [(True, False), (False, True), (True, True)])
def test_initial_boundary_respects_unchecked_options_and_incoming_links(context, grouping, links):
    root, monkeypatch, _ = context
    enable(monkeypatch)
    source, target = indexed(root), indexed(root, name="target.txt")
    def edge(a, b):
        return {"document_id": b["document_id"], "source_version": "v1", "version": "v1", "relation": "related",
                "source_chunk_id": f"{a['document_id']}:v1:t0", "target_chunk_id": f"{b['document_id']}:v1:t0"}
    outgoing, incoming = edge(source, target), edge(target, source)
    search.save_organization(root, source["document_id"], "v1", decision("Old", ["label"], [outgoing]))
    search.save_organization(root, target["document_id"], "v1", decision("Outside", links=[incoming]))
    move(source["document_id"], "Old")
    rebuild.request(folder="Old", grouping=grouping, links=links)
    row = search.get_document_status(root, source["document_id"])
    assert row["folder"] == ("New" if grouping else "Old")
    assert row["groups"] == ([] if grouping else ["label"])
    assert bool(organization_edits.override(root, source["document_id"])) is not grouping
    assert json.loads(row["links_json"]) == ([] if links else [outgoing])
    assert json.loads(search.get_document_status(root, target["document_id"])["links_json"]) == ([] if links else [incoming])


@pytest.mark.parametrize("cut", ["after_manual", "after_manifest"])
def test_initial_boundary_recovers_idempotently_and_later_manual_edit_wins(context, cut):
    root, monkeypatch, _ = context
    enable(monkeypatch)
    doc = indexed(root)
    search.save_organization(root, doc["document_id"], "v1", decision("Old"))
    move(doc["document_id"], "Old")
    original = organization_edits.atomic
    class Crash(BaseException):
        pass
    def interrupted(path, value):
        original(path, value)
        if ((cut == "after_manual" and path.name == "manual-organization.json" and value.get("change", {}).get("kind") == "reset")
                or (cut == "after_manifest" and path.name == "organization-published.json" and value.get("reset_request"))):
            raise Crash()
    monkeypatch.setattr(organization_edits, "atomic", interrupted)
    with pytest.raises(Crash):
        rebuild.request()
    monkeypatch.setattr(organization_edits, "atomic", original)
    move(doc["document_id"], "Manual after start")
    organization_store.recover(root)
    organization_store.recover(root)
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Manual after start"
    restart(monkeypatch)
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *a, **k: decision("Automatic"))
    while rebuild.process_one():
        pass
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Manual after start"
    assert rebuild.status()["status"] == "completed"
    assert storage.read_file(root, doc["document_id"])[0] == b"cat rests"


def test_publish_before_progress_checkpoint_replays_without_second_provider_call(context):
    root, monkeypatch, _ = context
    enable(monkeypatch)
    doc = indexed(root)
    calls = []
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *a, **k: (calls.append(1) or decision("Fresh")))
    rebuild.request()
    original = rebuild._persist
    class Crash(BaseException):
        pass
    def interrupted(state, progress_only=False):
        if state.get("cursor") == 1 and state["phase"] == "reviewing":
            raise Crash()
        return original(state, progress_only)
    monkeypatch.setattr(rebuild, "_persist", interrupted)
    with pytest.raises(Crash):
        rebuild.process_one()
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Fresh"
    monkeypatch.setattr(rebuild, "_persist", original)
    restart(monkeypatch)
    while rebuild.process_one():
        pass
    assert calls == [1] and rebuild.status()["status"] == "completed"
    assert len(storage.list_versions(root, doc["document_id"])) == 1


def test_retry_never_clears_already_published_files(context):
    root, monkeypatch, _ = context
    enable(monkeypatch)
    for name in ("a.txt", "b.txt"):
        indexed(root, name=name)
    calls = []
    def organize(doc, *a, **k):
        calls.append(doc["document_id"])
        return decision("Fresh") if len(calls) == 1 else {"status": "unavailable"}
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", organize)
    rebuild.request()
    while rebuild.process_one():
        pass
    published = calls[0]
    assert search.get_document_status(root, published)["folder"] == "Fresh"
    assert rebuild.status()["status"] == "partial_failure"
    rebuild.request(retry=True)
    assert search.get_document_status(root, published)["folder"] == "Fresh"
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *a, **k: decision("Retried"))
    while rebuild.process_one():
        pass
    assert search.get_document_status(root, published)["folder"] == "Fresh"
    assert rebuild.status()["status"] == "completed"


@pytest.mark.parametrize("changed", ["source", "supporting_neighbor"])
def test_progressive_completion_rejects_evidence_changed_after_first_publication(context, changed):
    root, monkeypatch, _ = context
    enable(monkeypatch)
    source, neighbor = indexed(root), indexed(root, name="neighbor.txt")
    search.save_organization(root, source["document_id"], "v1", decision("Old"))
    search.save_organization(root, neighbor["document_id"], "v1", decision("Outside"))
    def neighbors(*args, **kwargs):
        row = search.get_document_status(root, neighbor["document_id"])
        return [{**neighbor, "evidence_revision": row["evidence_revision"],
                 "evidence": search.document_evidence(root, neighbor["document_id"], "v1")}]
    monkeypatch.setattr(rebuild, "organization_neighbors", neighbors)
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *a, **k: decision("Fresh"))
    rebuild.request(folder="Old")
    assert rebuild.process_one()
    assert search.browse_documents(root, folder="Fresh")["total"] == 1
    modified = source if changed == "source" else neighbor
    # Exact original-passage checks remain effective even for an injected
    # same-head mutation before an evidence-epoch publisher is invoked.
    search._table(root, "chunks").update(
        where=f"document_id = '{modified['document_id']}'", values={"text": "Changed original extraction"})
    search._bump_revision(root, "index")
    assert not rebuild.process_one()
    state = rebuild.status()
    assert state["status"] == "partial_failure"
    assert source["document_id"] not in state["completed_ids"]
    assert "Evidence changed" in state["failures"][source["document_id"]]
    assert search.get_document_status(root, source["document_id"])["folder"] == "New"
    assert not search.find_documents(root, "cat", mode="keyword", folder="Fresh")
    assert storage.read_file(root, source["document_id"])[0] == b"cat rests"


def test_fresh_request_discards_only_superseded_failed_paid_receipts(context):
    root, monkeypatch, _ = context
    enable(monkeypatch)
    doc = indexed(root)
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *a, **k: decision("Fresh"))
    original = rebuild.save_organization
    def unavailable(*args, **kwargs):
        if kwargs.get("prepared") is not None:
            raise OSError("fixture interrupted publication")
        return original(*args, **kwargs)
    monkeypatch.setattr(rebuild, "save_organization", unavailable)
    prior = rebuild.request()["request_id"]
    while rebuild.process_one():
        pass
    assert rebuild.status()["status"] == "partial_failure"
    assert organization_store.staged_document(root, prior, doc["document_id"]) is not None
    organization_store.stage(root, "unrelated", doc["document_id"], "v1", decision("Unrelated"))
    monkeypatch.setattr(rebuild, "save_organization", original)
    current = rebuild.request()["request_id"]
    assert current != prior
    assert not (root / "temp/organization-staging" / prior).exists()
    assert organization_store.staged_document(root, "unrelated", doc["document_id"]) is not None
    assert search.get_document_status(root, doc["document_id"])["folder"] == "New"


def test_active_old_job_migration_preserves_inherited_manual_edits(context):
    root, monkeypatch, _ = context
    enable(monkeypatch)
    doc = indexed(root)
    rebuild.request()
    legacy = rebuild.status()
    legacy["request_id"] = "pre-progressive-reset"
    for name in ("reset_started", "reset_progressive", "reset_assignments"):
        legacy.pop(name, None)
    search.save_organization(root, doc["document_id"], "v1", decision("Old"))
    move(doc["document_id"], "Edited during older job")
    organization_edits.atomic(rebuild._path(), legacy)
    restart(monkeypatch)
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *a, **k: decision("Automatic"))
    assert rebuild.process_one()  # Upgrade the durable job and publish its boundary.
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Edited during older job"
    while rebuild.process_one():
        pass
    assert rebuild.status()["status"] == "completed"
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Edited during older job"
    # Compatibility does not weaken a subsequent explicit new Reset.
    rebuild.request()
    assert search.get_document_status(root, doc["document_id"])["folder"] == "New"
    assert storage.read_file(root, doc["document_id"])[0] == b"cat rests"
    assert len(storage.list_versions(root, doc["document_id"])) == 1


def test_delayed_starter_cannot_reclear_a_completed_job_after_next_job_starts(context):
    root, monkeypatch, _ = context
    enable(monkeypatch)
    first, second = indexed(root), indexed(root, name="second.txt")
    search.save_organization(root, first["document_id"], "v1", decision("Old first"))
    search.save_organization(root, second["document_id"], "v1", decision("Old second"))
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *a, **k: decision("Reviewed first"))
    stale = copy.deepcopy(rebuild.request(folder="Old first"))
    stale["reset_started"] = False
    while rebuild.process_one():
        pass
    latest = rebuild.request(folder="Old second")
    revision = search.revisions(root)
    returned = rebuild._start_reset(stale)
    assert returned["request_id"] == latest["request_id"]
    assert rebuild.status()["request_id"] == latest["request_id"]
    assert search.revisions(root) == revision
    assert search.get_document_status(root, first["document_id"])["folder"] == "Reviewed first"
    assert search.get_document_status(root, second["document_id"])["folder"] == "New"
