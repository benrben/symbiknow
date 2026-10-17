"""A bulk upload must not permanently consume an interrupted organization attempt."""

import pytest

from app import search, server, storage
from app.ingest import index_document
from test_search import FixtureEmbedder


@pytest.mark.parametrize("failure_stage", ["neighbors", "decision"])
def test_background_organization_retries_interrupted_attempt(tmp_path, monkeypatch, failure_stage):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setattr(server, "organization_attempts", set())
    monkeypatch.setattr(server, "retry_ids", set())
    monkeypatch.setattr(server, "status_cache", {})
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-only")
    server.stop.clear()
    metadata = storage.save_file(
        tmp_path, b"# Atlas / Protocol\nAtlas exposes upload and download.", "Atlas protocol.md"
    )
    index_document(
        tmp_path,
        metadata,
        b"# Atlas / Protocol\nAtlas exposes upload and download.",
        FixtureEmbedder(),
    )
    before = storage.list_versions(tmp_path, metadata["document_id"])
    attempts = []

    def maybe_fail(stage):
        if stage == failure_stage:
            attempts.append(stage)
            if len(attempts) == 1:
                raise search.IndexChangedError("Another upload changed the retrieval snapshot")

    def neighbors(*args):
        maybe_fail("neighbors")
        return []

    def organize(*args):
        maybe_fail("decision")
        return {"status": "evaluated", "folder": "Atlas", "groups": [], "links": []}

    monkeypatch.setattr(search, "organization_neighbors", neighbors)
    monkeypatch.setattr("app.jev.organize_document", organize)
    identity = (metadata["document_id"], metadata["version"])
    server.reconcile_once([metadata["document_id"]])
    assert metadata["document_id"] in server.retry_ids
    assert identity not in server.organization_attempts
    assert search.get_document_status(tmp_path, identity[0])["folder"] == ""
    server.reconcile_once([metadata["document_id"]])
    assert len(attempts) == 2
    assert search.get_document_status(tmp_path, identity[0])["folder"] == "Atlas"
    assert metadata["document_id"] not in server.retry_ids
    assert storage.list_versions(tmp_path, identity[0]) == before


def test_mcp_transfer_batch_errors_keep_actionable_message(tmp_path):
    import asyncio
    from mcp import Client
    from client import server_parameters

    async def exercise():
        async with Client(server_parameters(str(tmp_path), storage_only=True)) as client:
            for tool in ("upload", "download"):
                for count in (0, 33):
                    response = await client.call_tool(tool, {"files": [{}] * count})
                    assert response.is_error
                    message = "; ".join(getattr(part, "text", "") for part in response.content)
                    assert "Provide between 1 and 32 files per call" in message

    asyncio.run(exercise())
