"""Regressions from the live MCP end-to-end verification, isolated from the real library."""

import asyncio
import base64
from collections import OrderedDict
from types import SimpleNamespace
import uuid

from mcp import Client

from symbiknow.cli.client import call, server_parameters
from symbiknow.library import storage
from symbiknow.transfers.service import TransferService


def b64(value):
    return base64.b64encode(value).decode("ascii")


def test_request_errors_reach_the_agent_instead_of_a_masked_failure(tmp_path):
    async def exercise():
        async with Client(server_parameters(str(tmp_path / "data"), storage_only=True)) as client:
            async def error(tool, arguments):
                response = await client.call_tool(tool, arguments)
                assert response.is_error
                return response.content[0].text

            assert "No job with job_id" in await error("get_job", {"job_id": str(uuid.uuid4())})
            assert "file paths and shell operators" in await error(
                "search", {"query": "grep -F every dusk", "mode": "grep"})
            assert "8192 characters" in await error("ask", {"query": "x" * 9000})
            assert "Start at offset 0" in await error("download_folder", {"folder": "Any", "offset": 5})

    asyncio.run(exercise())


def test_identical_retry_of_completed_folder_upload_leaves_no_staged_payload(tmp_path):
    async def exercise():
        data = tmp_path / "data"
        arguments = {"folder": "Project", "request_id": str(uuid.uuid4()),
                     "files": [{"relative_path": "a/one.txt", "content_base64": b64(b"secret one")}]}
        async with Client(server_parameters(str(data), storage_only=True)) as client:
            first = await call(client, "upload_folder", arguments)
            again = await call(client, "upload_folder", arguments)
        assert first["files"][0]["stored"] and first["files"][0]["folder_assigned"]
        assert [f["document_id"] for f in again["files"]] == [f["document_id"] for f in first["files"]]
        assert list((data / "temp" / "folder-upload-jobs").glob("*.json")) == []

    asyncio.run(exercise())


def test_unknown_history_head_names_the_head_not_a_missing_document(tmp_path):
    async def exercise():
        async with Client(server_parameters(str(tmp_path / "data"), storage_only=True)) as client:
            stored = (await call(client, "upload", {"files": [
                {"filename": "one.txt", "content_base64": b64(b"one")}]}))["files"][0]
            item = (await call(client, "download", {"files": [{
                "document_id": stored["document_id"], "length": 1, "history": True, "history_head": "v99",
            }]}))["files"][0]
        assert "history_head 'v99' is not a version" in item["error"]
        assert "deleted or never uploaded" not in item["error"]

    asyncio.run(exercise())


def test_status_falls_back_to_index_row_when_cache_predates_restart(tmp_path, monkeypatch):
    metadata = storage.save_file(tmp_path, b"indexed before restart", "guide.md")
    rows = {"status": "indexed"}

    def row(data_dir, document_id):
        assert document_id == metadata["document_id"]
        return {"version": metadata["version"], "indexed_version": metadata["version"],
                "searchable_text": True, "searchable_visual": False, "index_error": "", **rows}

    monkeypatch.setattr("symbiknow.search.index.get_document_status", row)
    context = SimpleNamespace(DATA_DIR=tmp_path, STORAGE_ONLY=False, status_cache=OrderedDict(),
                              STATUS_CACHE_LIMIT=1)
    status = TransferService(context)._status(metadata)
    assert status["indexing_status"] == "indexed" and status["searchable"] is True
    assert context.status_cache[metadata["document_id"]]["status"] == "indexed"

    # Non-terminal rows are reported but never cached over a later worker update.
    context.status_cache.clear()
    rows["status"] = "pending"
    status = TransferService(context)._status(metadata)
    assert status["indexing_status"] == "pending" and not status["searchable"]
    assert context.status_cache == {}
