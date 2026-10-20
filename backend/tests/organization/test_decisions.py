"""Shared UI/agent decisions using real originals, evidence and organization stores."""
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from symbiknow.core.application import ApplicationContext
from symbiknow.library import storage
from symbiknow.organization import edits
from symbiknow.search import index
from tests.search.test_search import FixtureEmbedder, _add


@pytest.fixture
def pending(tmp_path):
    storage.init_storage(tmp_path)
    embedder = FixtureEmbedder()
    source = _add(tmp_path, embedder, "API notes.md", b"# Atlas API\nThe cat API manages project records.")
    target = _add(tmp_path, embedder, "Architecture.md", b"# Atlas architecture\nThe cat service stores API records.")
    source_row = index.get_document_status(tmp_path, source["document_id"])
    target_row = index.get_document_status(tmp_path, target["document_id"])
    se = index.document_evidence(tmp_path, source["document_id"], source["version"])[0]["evidence_id"]
    te = index.document_evidence(tmp_path, target["document_id"], target["version"])[0]["evidence_id"]
    state = dict(status="evaluated", folder="", groups=[], links=[], origin="jev",
                 ownership=dict(outcome="multiple_projects", candidates={"o0": "Engineering", "o1": "Research"},
                                probabilities={"o0": .48, "o1": .45}),
                 evidence_revision=source_row["evidence_revision"], evidence_ids=[se],
                 dependency_evidence_revisions={target["document_id"]: target_row["evidence_revision"]},
                 link_evaluations=[dict(document_id=target["document_id"], version=target["version"],
                                        source_chunk_id=se, target_chunk_id=te, relation="none", topic=.67,
                                        support=.3, conflict=.1, accepted=False)])
    index.save_organization(tmp_path, source["document_id"], source["version"], state)
    return ApplicationContext(tmp_path), source, target, state, embedder


def test_accept_folder_and_agent_link_shared_durable_receipts(pending):
    context, source, target, _, _ = pending
    folder, link = context.decisions.list()["decisions"]
    assert folder["kind"] == "folder" and link["kind"] == "connection"
    assert "cat API" in folder["excerpt"] and "cat service" in link["target_excerpt"]
    receipt = context.decisions.resolve(folder["id"], "accept")
    assert edits.override(context.DATA_DIR, source["document_id"])["folder"] == "Engineering"
    assert context.decisions.resolve(folder["id"], "accept", actor="agent") == receipt
    context.decisions.resolve(link["id"], "accept", actor="agent")
    row = index.get_document_status(context.DATA_DIR, source["document_id"])
    assert json.loads(row["links_json"])[0]["document_id"] == target["document_id"]
    assert json.loads(row["links_json"])[0]["reviewed_by"] == "agent"
    assert ApplicationContext(context.DATA_DIR).decisions.list()["decisions"] == []
    with pytest.raises(ValueError, match="already handled"):
        context.decisions.resolve(folder["id"], "skip")


def test_skip_and_change(pending):
    context, source, _, _, _ = pending
    folder, link = context.decisions.list()["decisions"]
    context.decisions.resolve(folder["id"], "change", "Product / API")
    context.decisions.resolve(link["id"], "skip", actor="agent")
    assert edits.override(context.DATA_DIR, source["document_id"])["folder"] == "Product / API"
    assert not json.loads(index.get_document_status(context.DATA_DIR, source["document_id"])["links_json"])
    assert ApplicationContext(context.DATA_DIR).decisions.list()["decisions"] == []


@pytest.mark.parametrize("which", ["source", "target"])
def test_source_or_target_update_rejects_old_proposal(pending, which):
    context, source, target, _, embedder = pending
    folder, link = context.decisions.list()["decisions"]
    document = source if which == "source" else target
    _add(context.DATA_DIR, embedder, document["filename"], b"Changed current content",
         document_id=document["document_id"], expected_version=document["version"])
    with pytest.raises(ValueError, match="changed or was handled"):
        context.decisions.resolve(link["id"], "accept")
    if which == "source":
        with pytest.raises(ValueError):
            context.decisions.resolve(folder["id"], "accept")


def test_same_version_reextraction_rejects_old_proposal(pending):
    context, source, _, _, embedder = pending
    decision = context.decisions.list()["decisions"][0]
    from symbiknow.ingestion.service import index_document
    index_document(context.DATA_DIR, source, b"Replacement extraction from this version", embedder)
    with pytest.raises(ValueError):
        context.decisions.resolve(decision["id"], "accept")


def test_manual_move_wins_over_pending_folder(pending):
    context, source, _, _, _ = pending
    decision = context.decisions.list()["decisions"][0]
    edits.edit("move-documents", {"folder": "Chosen manually", "documents": [
        {"document_id": source["document_id"], "expected_version": source["version"]}]}, context)
    with pytest.raises(ValueError):
        context.decisions.resolve(decision["id"], "accept")
    assert edits.override(context.DATA_DIR, source["document_id"])["folder"] == "Chosen manually"


def test_competing_user_agent_only_one_wins(pending):
    context, _, _, _, _ = pending
    decision = context.decisions.list()["decisions"][0]
    def attempt(action):
        try:
            return context.decisions.resolve(decision["id"], action, actor="agent")
        except ValueError:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(attempt, ["accept", "skip"]))
    assert len([reply for reply in replies if reply]) == 1


@pytest.mark.parametrize("outcome", ["no_project", "insufficient_evidence", "accepted"])
def test_confident_negative_or_unavailable_work_is_quiet(pending, outcome):
    context, source, _, state, _ = pending
    state.update(ownership=dict(outcome=outcome), folder_confidence=.99, link_evaluations=[])
    index.save_organization(context.DATA_DIR, source["document_id"], source["version"], state)
    assert context.decisions.list()["decisions"] == []
    state["status"] = "unavailable"
    index.save_organization(context.DATA_DIR, source["document_id"], source["version"], state)
    assert context.decisions.list()["decisions"] == []


def test_bounded_queue_and_validation(pending):
    context, _, _, _, _ = pending
    page = context.decisions.list(1)
    assert len(page["decisions"]) == 1 and page["has_more"]
    decision = page["decisions"][0]
    with pytest.raises(ValueError):
        context.decisions.resolve(decision["id"], "change", "../bad")
    with pytest.raises(ValueError):
        context.decisions.resolve(decision["id"], "accept", "unexpected")
    assert len(context.decisions.list()["decisions"]) == 2


def test_http_and_mcp_share_queue(pending, monkeypatch):
    from starlette.testclient import TestClient
    from symbiknow.api import http, mcp
    context, _, _, _, _ = pending
    monkeypatch.setattr(mcp, "application", lambda: context)
    client = TestClient(http.create_app(), base_url="http://127.0.0.1")
    queue = client.get("/api/jev-decisions").json()
    assert queue == mcp.list_jev_decisions()
    decision = queue["decisions"][0]
    response = client.post("/api/jev-decision", json={"decision_id": decision["id"], "action": "skip"},
                           headers={"Origin": "http://127.0.0.1", "X-Symbiknow-UI": "1"})
    assert response.status_code == 200 and response.json()["actor"] == "user"
    link = mcp.list_jev_decisions()["decisions"][0]
    assert mcp.resolve_jev_decision(link["id"], "change", "supports")["actor"] == "agent"
    assert client.get("/api/jev-decisions").json()["decisions"] == []


def test_original_head_change_before_index_update_is_rejected(pending):
    context, source, _, _, _ = pending
    decision = context.decisions.list()["decisions"][0]
    storage.save_file(context.DATA_DIR, b"new original", source["filename"],
                      document_id=source["document_id"], expected_version=source["version"])
    with pytest.raises(ValueError):
        context.decisions.resolve(decision["id"], "accept")


def test_uncertain_subfolder_and_rejected_link_not_repeated(pending):
    context, source, _, state, _ = pending
    state.update(ownership={"outcome": "accepted"}, folder="Atlas", folder_confidence=.52,
                 folder_candidates=["Atlas / Engineering", "Atlas / Research"],
                 folder_probabilities={"f0": .52, "f1": .4})
    state["link_evaluations"][0]["topic"] = .1
    index.save_organization(context.DATA_DIR, source["document_id"], source["version"], state)
    queue = context.decisions.list()["decisions"]
    assert len(queue) == 1 and queue[0]["suggested"] == "Atlas / Engineering"


def test_real_stdio_decision_tools_discovery_and_validation(tmp_path):
    import asyncio
    from mcp import Client
    from symbiknow.cli.client import call, server_parameters

    async def exercise():
        async with Client(server_parameters(str(tmp_path / "isolated"), storage_only=True)) as session:
            tools = {tool.name: tool for tool in (await session.list_tools()).tools}
            assert tools["list_jev_decisions"].annotations.read_only_hint
            assert not tools["resolve_jev_decision"].annotations.destructive_hint
            assert set(tools["resolve_jev_decision"].input_schema["required"]) == {"decision_id", "action"}
            assert await call(session, "list_jev_decisions", {}) == {"decisions": [], "has_more": False}
            with pytest.raises(ValueError):
                await call(session, "resolve_jev_decision", {"decision_id": "missing", "action": "accept"})
    asyncio.run(exercise())


def test_connection_already_accepted_at_other_endpoint_is_quiet(pending):
    context, source, target, state, _ = pending
    audit = state["link_evaluations"][0]
    index.save_organization(context.DATA_DIR, target["document_id"], target["version"], {
        "status": "evaluated", "folder": "", "groups": [], "links": [{
            "document_id": source["document_id"], "version": source["version"],
            "source_version": target["version"], "relation": "related",
            "source_chunk_id": audit["target_chunk_id"], "target_chunk_id": audit["source_chunk_id"],
        }],
    })
    assert [p["kind"] for p in context.decisions.list()["decisions"]] == ["folder"]


def test_same_connection_is_one_question_and_skip_covers_both_directions(pending):
    context, source, target, state, _ = pending
    audit = state["link_evaluations"][0]
    source_row = index.get_document_status(context.DATA_DIR, source["document_id"])
    index.save_organization(context.DATA_DIR, target["document_id"], target["version"], {
        "status": "evaluated", "folder": "", "groups": [], "links": [],
        "evidence_ids": [audit["target_chunk_id"]],
        "dependency_evidence_revisions": {source["document_id"]: source_row["evidence_revision"]},
        "link_evaluations": [{"document_id": source["document_id"], "version": source["version"],
            "source_chunk_id": audit["target_chunk_id"], "target_chunk_id": audit["source_chunk_id"],
            "topic": .65, "accepted": False}],
    })
    links = [p for p in context.decisions.list()["decisions"] if p["kind"] == "connection"]
    assert len(links) == 1
    context.decisions.resolve(links[0]["id"], "skip")
    assert all(p["kind"] == "folder" for p in ApplicationContext(context.DATA_DIR).decisions.list()["decisions"])
