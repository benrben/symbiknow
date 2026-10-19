"""UI and MCP share bounded answer retrieval and expose skipped checks honestly."""

import asyncio
from copy import deepcopy

from mcp import Client
import pytest
from starlette.testclient import TestClient

from app import jev, jev_proof, search, server, ui
from test_jev_proof import document, sdk


@pytest.fixture
def shared_search(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setattr(jev_proof, "_CACHE", jev_proof.ByteLRU())
    calls = []

    def retrieve(root, query, mode, limit, folder, group, **kwargs):
        calls.append((mode, limit, folder, group))
        # A larger retrieval window can collect more passages per document.
        # Before the fix the UI's 40-result request exceeded the proof budget.
        texts = ("Hybrid combines keywords and semantic search.",)
        if limit > 10:
            texts = tuple("hybrid " * 250 for _ in range(12))
        return [document(f"d{i}", texts) for i in range(limit)]

    def provider(state, questions, client=None):
        with sdk() as client:
            return client.system_one(state=state, questions=questions)

    monkeypatch.setattr(search, "find_documents", retrieve)
    monkeypatch.setattr(jev, "_call", provider)
    monkeypatch.setattr(
        server,
        "_refresh_matches",
        lambda rows, *a, **k: (deepcopy(rows), {"index": "fixture", "organization": "fixture"}),
    )
    return calls, TestClient(ui.create_app(), base_url="http://127.0.0.1")


def test_ui_and_actual_mcp_sdk_share_one_answer_window(shared_search):
    calls, http = shared_search
    response = http.post(
        "/api/search",
        json={"query": "what is hybrid mode?", "mode": "hybrid", "evaluate": True, "limit": 40},
        headers={"Origin": "http://127.0.0.1", "X-Symbiknow-UI": "1"},
    )
    assert response.status_code == 200
    browser = response.json()

    async def from_mcp():
        async with Client(server.mcp) as client:
            result = await client.call_tool(
                "search",
                {"query": "what is hybrid mode?", "mode": "answer", "limit": 10, "detail": "full"},
            )
            assert not result.is_error
            return result.structured_content

    mcp = asyncio.run(from_mcp())
    assert calls == [("hybrid", 8, None, None)] * 2
    assert browser["answer"] == mcp["answer"]
    assert browser["answer"]["status"] == "answered"
    assert browser["answer"]["evaluated_count"] == 8
    for result in (browser, mcp):
        assert [d["document_id"] for d in result["matches"]] == [f"d{i}" for i in range(8)]
    assert [d["jev"] for d in browser["matches"]] == [d["jev"] for d in mcp["matches"]]


def test_browsing_keeps_requested_window_and_small_answer_limit_is_honored(shared_search):
    calls, _ = shared_search
    browsed = server.search("hybrid", mode="hybrid", limit=40, detail="full")
    assert len(browsed["matches"]) == 40
    answered = server.search("hybrid", mode="answer", limit=2, detail="full")
    assert len(answered["matches"]) == 2
    assert [c[1] for c in calls] == [40, 2]


def test_context_budget_reason_survives_actual_ui_and_mcp_projection(shared_search, monkeypatch):
    _, http = shared_search
    too_long = document(texts=tuple("x" * 2400 for _ in range(8)))
    monkeypatch.setattr(search, "find_documents", lambda *a, **k: [too_long])
    response = http.post(
        "/api/search",
        json={"query": "what is hybrid mode?", "evaluate": True},
        headers={"Origin": "http://127.0.0.1", "X-Symbiknow-UI": "1"},
    )
    assert response.status_code == 200
    browser = response.json()
    compact = server.search("what is hybrid mode?", mode="answer", detail="compact")
    for result in (browser, compact):
        assert not result["matches"]
        assert result["answer"]["status"] == "not_evaluated"
        assert result["answer"]["reason"] == "context_budget"
        assert result["answer"]["evaluated_count"] == 0
