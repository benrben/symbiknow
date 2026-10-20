"""MCP removal uses the same guarded library deletion as the UI."""

import asyncio
import json

import pytest
from mcp import Client

from symbiknow.organization import rebuild
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.library import storage
from symbiknow.cli.client import call
from tests.api.test_ui_api import context as context, decision, indexed


@pytest.mark.parametrize("status", ["queued", "running"])
def test_remove_file_blocks_rebuild_then_cleans_search_and_relationships(context, status):
    root, monkeypatch, _ = context
    target = indexed(root, name="target.txt")
    source = indexed(root, name="kept.txt")
    search.save_organization(root, source["document_id"], "v1", decision("Kept", links=[{
        "document_id": target["document_id"], "source_version": "v1", "version": "v1",
        "source_chunk_id": f"{source['document_id']}:v1:t0",
        "target_chunk_id": f"{target['document_id']}:v1:t0", "relation": "related",
    }]))

    async def exercise():
        async with Client(server.mcp) as session:
            args = {"document_id": target["document_id"], "expected_version": "v1"}
            with monkeypatch.context() as patch:
                patch.setattr(rebuild, "status", lambda *a: {"status": status})
                with pytest.raises(ValueError, match="rebuild to finish"):
                    await call(session, "remove_file", args)
            assert storage.read_file(root, target["document_id"])[0] == b"cat rests"
            assert await call(session, "remove_file", args) == {"deleted": target["document_id"]}
            assert search.get_document_status(root, target["document_id"]) is None
            assert json.loads(search.get_document_status(root, source["document_id"])["links_json"]) == []
            matches = search.find_documents(root, "cat", mode="keyword")
            assert {row["document_id"] for row in matches} == {source["document_id"]}
    asyncio.run(exercise())
