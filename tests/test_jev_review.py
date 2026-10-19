"""Non-destructive Jev review jobs against real versioned storage and index."""

import json

import pytest

from app import jev, organization_edits, rebuild, search, server, storage, ui
from app.ingest import index_document
from test_search import FixtureEmbedder
from test_ui_api import context as context, indexed, add, decision, mutate
from test_jev import match, sdk_client


def enable(monkeypatch):
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-only")


def link(source, target, relation="related"):
    return {
        "document_id": target["document_id"],
        "version": target["version"],
        "source_version": source["version"],
        "relation": relation,
        "source_chunk_id": f"{source['document_id']}:{source['version']}:t0",
        "target_chunk_id": f"{target['document_id']}:{target['version']}:t0",
    }


def row(root, meta):
    return search.get_document_status(root, meta["document_id"])


def finish():
    for _ in range(20):
        if not rebuild.process_one():
            return rebuild.status()
    raise AssertionError("Review did not finish")


def test_unfiled_review_preserves_organization_links_manual_placements_and_layout(context):
    root, patch, client = context
    enable(patch)
    unfiled = indexed(root, name="symbiknow-notes.md")
    existing = indexed(root, name="symbiknow-architecture.md")
    manual = indexed(root, name="intentionally-unfiled.md")
    incoming, outgoing = link(existing, unfiled), link(unfiled, existing)
    search.save_organization(
        root, existing["document_id"], "v1", decision("Symbiknow / Development", links=[incoming])
    )
    search.save_organization(
        root, unfiled["document_id"], "v1", decision("", ["Keep this group"], [outgoing])
    )
    organization_edits.edit(
        "move-documents",
        {
            "documents": [{"document_id": manual["document_id"], "expected_version": "v1"}],
            "folder": "",
        },
    )
    before, manual_before = row(root, existing), organization_edits.read(root)
    assert client.get("/api/library").json()["unfiled_review_count"] == 1
    seen = []

    def organize(meta, *args, **kwargs):
        seen.append(meta["document_id"])
        assert "Symbiknow / Development" in kwargs["folders"]
        current = ui.rebuild_public(rebuild.status())
        assert current["current_filename"] == "symbiknow-notes.md"
        assert current["activity"] == "Reviewing folders and links"
        assert current["completed"] == 0 and current["total"] == 1
        return decision("Symbiknow / Development", ["New group"], [outgoing])

    patch.setattr(jev, "organize_document", organize)
    result = mutate(client, "rebuild", {"mode": "unfiled"})
    assert result.status_code == 200
    assert result.json()["mode"] == "unfiled"
    assert row(root, unfiled)["links_json"] == json.dumps([outgoing])
    assert row(root, existing) == before
    with pytest.raises(ValueError, match="already running"):
        rebuild.request(mode="links")
    completed = finish()
    assert seen == [unfiled["document_id"]]
    assert completed["status"] == "completed" and completed["layout_revision"] == ""
    assert completed["current_filename"] == ""
    assert row(root, unfiled)["folder"] == "Symbiknow / Development"
    assert set(row(root, unfiled)["groups"]) == {"Keep this group", "New group"}
    assert json.loads(row(root, unfiled)["links_json"]) == [outgoing]
    assert row(root, existing) == before
    assert organization_edits.read(root) == manual_before
    assert row(root, manual)["folder"] == ""
    assert len(storage.list_versions(root, unfiled["document_id"])) == 1
    assert client.get("/api/library").json()["unfiled_review_count"] == 0


def test_links_only_adds_without_replacing_project_metadata_or_incoming_links(context):
    root, patch, _ = context
    enable(patch)
    source, old, new = (indexed(root, name=name) for name in ["source.md", "old.md", "new.md"])
    accepted = link(source, old)
    addition = link(source, new, "supports")
    old_decision = {
        **decision("Symbiknow / Design", ["Pinned group"], [accepted]),
        "ownership": {"outcome": "accepted"},
        "evidence_ids": [accepted["source_chunk_id"]],
    }
    search.save_organization(root, source["document_id"], "v1", old_decision)
    search.save_organization(
        root, new["document_id"], "v1", decision("Other", links=[link(new, source)])
    )
    outside_before = row(root, new)

    def organize(*args, **kwargs):
        assert kwargs["links_only"] is True
        return decision("Must not replace", ["Must not replace"], [addition])

    patch.setattr(jev, "organize_document", organize)
    for _ in range(2):
        request = rebuild.request(mode="links", folder="Symbiknow")
        assert request["grouping"] is False
        assert request["document_ids"] == [source["document_id"]]
        assert finish()["status"] == "completed"
    updated = row(root, source)
    assert updated["folder"] == "Symbiknow / Design" and updated["groups"] == ["Pinned group"]
    assert json.loads(updated["links_json"]) == [accepted, addition]
    assert json.loads(updated["organization_json"])["ownership"] == old_decision["ownership"]
    assert row(root, new) == outside_before
    assert storage.read_file(root, source["document_id"])[0] == b"cat rests"


@pytest.mark.parametrize("mode", ["unfiled", "links"])
def test_review_failure_and_retry_never_clear_existing_data(context, mode):
    root, patch, _ = context
    enable(patch)
    source, target = indexed(root), indexed(root, name="target.md")
    search.save_organization(root, target["document_id"], "v1", decision("Outside"))
    search.save_organization(
        root, source["document_id"], "v1", decision("", links=[link(source, target)])
    )
    before = row(root, source)
    patch.setattr(jev, "organize_document", lambda *a, **k: {"status": "unavailable"})
    job = rebuild.request(mode=mode, folder="")
    assert finish()["status"] == "partial_failure"
    assert row(root, source) == before
    patch.setattr(jev, "organize_document", lambda *a, **k: decision(""))
    retried = rebuild.request(retry=True)
    assert retried["mode"] == mode and retried["request_id"] == job["request_id"]
    assert retried["phase"] != "clearing" and retried["layout_revision"] == ""
    assert finish()["status"] == "completed"
    assert row(root, source)["links_json"] == before["links_json"]


@pytest.mark.parametrize("mode", ["unfiled", "links"])
def test_review_rejects_stale_source_and_retries_latest_version(context, mode):
    root, patch, _ = context
    enable(patch)
    source = indexed(root)

    def upload(*a, **k):
        meta = add(root, document_id=source["document_id"], content=b"Latest version")
        index_document(root, meta, b"Latest version", FixtureEmbedder())
        return decision("Stale")

    patch.setattr(jev, "organize_document", upload)
    rebuild.request(mode=mode)
    rebuild.process_one()
    assert not rebuild.status()["completed_ids"] and not rebuild.status()["failures"]
    assert row(root, source)["folder"] != "Stale"
    patch.setattr(jev, "organize_document", lambda *a, **k: decision("Current"))
    assert finish()["status"] == "completed"
    assert row(root, source)["version"] == "v2"
    assert storage.read_file(root, source["document_id"], "v1")[0] == b"cat rests"


def test_unfiled_scope_does_not_override_a_late_placement_and_skips_no_text(context):
    root, patch, _ = context
    enable(patch)
    source, empty = indexed(root), add(root, name="empty.txt", content=b"")
    search.set_document_status(root, empty, status="empty")

    def late_move(*a, **k):
        search.save_organization(root, source["document_id"], "v1", decision("Already placed"))
        return decision("Must not overwrite")

    patch.setattr(jev, "organize_document", late_move)
    rebuild.request(mode="unfiled")
    state = finish()
    assert len(state["skips"]) == 2
    assert row(root, source)["folder"] == "Already placed"
    assert row(root, empty)["organization_status"] != "reset_skipped"


def test_review_availability_and_invalid_modes_leave_state_intact(context):
    root, patch, client = context
    source = indexed(root)
    before = row(root, source)
    assert mutate(client, "rebuild", {"mode": "bad"}).status_code == 400
    assert mutate(client, "rebuild", {"mode": "unfiled"}).status_code == 400
    enable(patch)
    search.save_organization(root, source["document_id"], "v1", decision("Filed"))
    with pytest.raises(ValueError, match="No files eligible"):
        rebuild.request(mode="unfiled")
    assert rebuild.status() is None
    assert before["version"] == row(root, source)["version"]


def test_links_only_sdk_request_asks_only_relationship_questions(monkeypatch):
    calls = []

    def capture(state, questions, client=None):
        calls.append(questions)
        with sdk_client({"link_0": "supports", "source_0": "p0", "target_0": "p0"}) as sdk:
            return sdk.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", capture)
    source, target = match(), match("doc2")
    result = jev.organize_document(
        source, source["evidence"], [target], folders=["Atlas"], links_only=True
    )
    assert result["status"] == "evaluated" and len(result["links"]) == 1
    assert len(calls) == 1 and set(calls[0]) == {"pair_1_0_0", "status_0_0", "status_1_0"}
    assert "folder" not in result and "groups" not in result
    calls.clear()
    assert jev.organize_document(source, source["evidence"], [], links_only=True)["links"] == []
    assert calls == []


def test_owner_acceptance_is_not_overwritten_by_a_rejected_link():
    source = match("source", text="Atlas / Storage / Guide\nAtlas preserves versions.")
    target = match("target", text="Unrelated weather record.")
    with sdk_client(
        {"project_owner": "Atlas", "pair_1_0_0": "none"}
    ) as sdk:
        result = jev.organize_document(
            source, source["evidence"], [target], folders=["Atlas / Storage"], client=sdk
        )
    assert result["folder"].startswith("Atlas")
    assert result["ownership"]["outcome"] == "accepted"
    assert result["links"] == []


def test_unfiled_outcome_is_visible_in_successful_job(context):
    root, patch, client = context
    enable(patch)
    source = indexed(root)
    reason = "Several projects have equal ownership; choose a folder manually"
    patch.setattr(
        jev, "organize_document", lambda *a, **k: {**decision(""), "organization_reason": reason}
    )
    rebuild.request(mode="unfiled")
    assert finish()["status"] == "completed"
    public = client.get("/api/rebuild").json()
    assert public["completed"] == 1 and public["grouped"] == 0 and public["unfiled"] == 1
    assert public["links_added"] == 0
    assert public["details"] == [
        {
            "document_id": source["document_id"],
            "filename": source["filename"],
            "outcome": "unfiled",
            "reason": reason,
        }
    ]


def test_reset_links_only_does_not_ask_for_ownership(context):
    root, patch, _ = context
    enable(patch)
    source = indexed(root)
    search.save_organization(
        root,
        source["document_id"],
        "v1",
        {
            **decision("Atlas / Storage", ["Stored"]),
            "canonical_project": jev.project_identity("Atlas"),
            "ownership": {"outcome": "accepted"},
        },
    )
    calls = []

    def organize(*a, **k):
        calls.append(k)
        return {"status": "evaluated", "links": []}

    patch.setattr(jev, "organize_document", organize)
    rebuild.request(mode="reset", grouping=False, links=True)
    assert finish()["status"] == "completed"
    assert calls[0]["links_only"] is True
    assert row(root, source)["folder"] == "Atlas / Storage"
    assert row(root, source)["groups"] == ["Stored"]
    assert row(root, source)["organization_status"] == "evaluated"
    details = json.loads(row(root, source)["organization_json"])
    assert details["ownership"] == {"outcome": "accepted"}
    assert details["canonical_project"]["name"] == "Atlas"


def test_automatic_visual_only_organization_is_not_a_provider_failure(context):
    root, patch, client = context
    enable(patch)
    source = indexed(root)
    patch.setattr(search, "document_evidence", lambda *a, **k: [{"text": "", "basis": "visual"}])
    patch.setattr(search, "organization_neighbors", lambda *a: [])
    patch.setattr(jev, "_call", lambda *a, **k: pytest.fail("No text should not call Jev"))
    server.reconcile_once([source["document_id"]])
    assert row(root, source)["organization_status"] == "not_evaluated"
    assert client.get("/api/library").json()["processing_states"].get("organization_failed", 0) == 0
    assert (
        "No extracted text"
        in ui.detail(source["document_id"])["organization_review"]["organization_reason"]
    )


@pytest.mark.asyncio
async def test_mcp_retries_one_retrieval_race_then_explains_busy_state(context):
    from mcp import Client

    root, patch, _ = context
    enable(patch)
    patch.setattr(server, "_worker", lambda: None)
    indexed(root)
    calls = []

    def raced(*a, **k):
        calls.append(1)
        if len(calls) == 1:
            raise search.IndexChangedError("changed")
        return []

    patch.setattr(search, "find_documents", raced)
    async with Client(server.mcp) as client:
        result = await client.call_tool("search", {"query": "Atlas", "mode": "keyword"})
        assert not result.is_error and len(calls) == 2
        assert result.structured_content["metrics"]["retrieval_retries"] == 1

        def busy(*a, **k):
            calls.append(1)
            raise search.IndexChangedError("changed")

        patch.setattr(search, "find_documents", busy)
        calls.clear()
        result = await client.call_tool("search", {"query": "Atlas", "mode": "keyword"})
        assert result.is_error and len(calls) == 2
        assert "Retry this search" in result.content[0].text
        invalid = await client.call_tool("search", {"query": "Atlas", "continuation": "bad"})
        assert invalid.is_error and "restart search" in invalid.content[0].text
