"""Real MCP stdio interoperability, not direct Python tool calls."""

import asyncio
import base64
import hashlib
from pathlib import Path
import uuid

from mcp import Client

from client import call, download_files, server_parameters, upload_files
from app.storage import list_versions


def encoded(content):
    return base64.b64encode(content).decode("ascii")


def test_real_stdio_bulk_versions_retry_and_bytes(tmp_path):
    async def exercise():
        data = tmp_path / "data"
        original = bytes(range(256)) * 17 + b"\x00\xff\n"
        second = b"Updated document\n" + bytes(range(255, -1, -1))
        one, two = tmp_path / "binary.dat", tmp_path / "notes.txt"
        one.write_bytes(original)
        two.write_bytes(b"First notes\n")
        request_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        async with Client(server_parameters(str(data), storage_only=True)) as session:
            tools = await session.list_tools()
            assert {tool.name for tool in tools.tools} == {"upload", "download", "search"}
            uploaded = await upload_files(session, [one, two], request_ids=request_ids)
            assert all(item["stored"] and not item["searchable"] for item in uploaded)
            repeated = await upload_files(session, [one, two], request_ids=request_ids)
            assert [(item["document_id"], item["version"]) for item in repeated] == [
                (item["document_id"], "v1") for item in uploaded
            ]
            one.write_bytes(second)
            updated = (
                await upload_files(
                    session, [one], document_id=uploaded[0]["document_id"], expected_version="v1"
                )
            )[0]
            assert updated["version"] == "v2"
            conflict = await call(
                session,
                "upload",
                {
                    "files": [
                        {
                            "filename": "binary.dat",
                            "document_id": uploaded[0]["document_id"],
                            "content_base64": encoded(b"conflict"),
                            "expected_version": "v1",
                            "request_id": str(uuid.uuid4()),
                        }
                    ]
                },
            )
            assert conflict["files"][0]["stored"] is False
            assert "Expected v1" in conflict["files"][0]["error"]
            response = await call(
                session,
                "download",
                {
                    "files": [
                        {"document_id": uploaded[0]["document_id"], "version": "v1"},
                        {
                            "document_id": uploaded[0]["document_id"],
                            "version": "v2",
                            "history": True,
                        },
                        {"document_id": uploaded[1]["document_id"]},
                    ]
                },
            )
            assert [base64.b64decode(item["content_base64"]) for item in response["files"]] == [
                original,
                second,
                b"First notes\n",
            ]
            assert [entry["version"] for entry in response["files"][1]["versions"]] == ["v1", "v2"]
            assert response["files"][0]["filename"] == "binary.dat"
            assert response["files"][0]["source"] == str(one.resolve())
            status = await call(session, "search", {"query": "notes"})
            assert status["status"] == "indexing_disabled"
            downloaded = await download_files(
                session,
                [
                    {"document_id": uploaded[0]["document_id"], "version": "v1"},
                    {"document_id": uploaded[0]["document_id"], "version": "v2"},
                ],
                tmp_path / "downloads",
                chunk_bytes=97,
            )
            assert [Path(item["output_path"]).read_bytes() for item in downloaded] == [
                original,
                second,
            ]
        async with Client(server_parameters(str(data), storage_only=True)) as restarted:
            response = await call(
                restarted,
                "download",
                {"files": [{"document_id": uploaded[0]["document_id"], "version": "v1"}]},
            )
            assert base64.b64decode(response["files"][0]["content_base64"]) == original
        assert [item["version"] for item in list_versions(data, uploaded[0]["document_id"])] == [
            "v1",
            "v2",
        ]

    asyncio.run(exercise())


def test_chunk_resume_retry_sha_and_client_transfer(tmp_path):
    async def exercise():
        data = tmp_path / "data"
        content = bytes(range(256)) * 3000
        request_id = str(uuid.uuid4())
        common = {
            "filename": "big.bin",
            "source": "/original/big.bin",
            "mime_type": "application/octet-stream",
            "request_id": request_id,
            "total_size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
        async with Client(server_parameters(str(data), storage_only=True)) as first:
            request = dict(common, offset=0, content_base64=encoded(content[:200000]), final=False)
            result = await call(first, "upload", {"files": [request]})
            assert result["files"][0]["stored"] is False
            retry = await call(first, "upload", {"files": [request]})
            assert retry["files"][0]["received_bytes"] == 200000
        async with Client(server_parameters(str(data), storage_only=True)) as second:
            for offset in range(200000, len(content), 200000):
                piece = content[offset : offset + 200000]
                request = dict(
                    common,
                    offset=offset,
                    content_base64=encoded(piece),
                    final=offset + len(piece) == len(content),
                )
                result = await call(second, "upload", {"files": [request]})
            committed = result["files"][0]
            assert committed["stored"] and committed["version"] == "v1"
            retry = await call(second, "upload", {"files": [request]})
            assert retry["files"][0]["version"] == "v1"
            bad = dict(common, offset=0, content_base64=encoded(b"bad"), sha256="0" * 64)
            rejected = await call(second, "upload", {"files": [bad]})
            assert rejected["files"][0]["stored"] is False
            output = await download_files(
                second,
                [{"document_id": committed["document_id"]}],
                tmp_path / "downloads",
                chunk_bytes=200000,
            )
            assert Path(output[0]["output_path"]).read_bytes() == content
            path = tmp_path / "client-large.bin"
            path.write_bytes(content)
            client_result = await upload_files(second, [path], chunk_bytes=200000)
            assert client_result[0]["stored"]
            output2 = await download_files(
                second, [{"document_id": client_result[0]["document_id"]}], tmp_path / "downloads"
            )
            assert Path(output2[0]["output_path"]).read_bytes() == content
        assert len(list_versions(data, committed["document_id"])) == 1

    asyncio.run(exercise())


def test_reconcile_restarts_indexing_without_versions_and_rejects_stale_hits(tmp_path, monkeypatch):
    """Real stored heads, cheap injected derived index: crash gap and stale-hit guards."""
    from app import server, storage, ingest, search, jev

    data = tmp_path / "data"
    monkeypatch.setattr(server, "DATA_DIR", data)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    server.stop.clear()
    states = {}
    calls = []
    monkeypatch.setattr(search, "get_document_status", lambda _root, doc: states.get(doc))

    def index(_root, metadata, content):
        calls.append(
            (
                metadata["document_id"],
                metadata["version"],
                content.read_bytes() if isinstance(content, Path) else content,
            )
        )
        states[metadata["document_id"]] = dict(
            metadata,
            status="indexed",
            indexed_version=metadata["version"],
            organization_status="evaluated",
        )
        return states[metadata["document_id"]]

    monkeypatch.setattr(ingest, "index_document", index)
    first = storage.save_file(data, b"old evidence", "test.txt")
    assert server.reconcile_once() == 1
    second = storage.save_file(
        data, b"current evidence", "test.txt", document_id=first["document_id"]
    )
    stale = {
        "document_id": first["document_id"],
        "version": "v1",
        "evidence": [{"text": "old evidence", "evidence_id": "old"}],
    }
    monkeypatch.setattr(search, "find_documents", lambda *args, **kwargs: [stale])
    # OCFL commit succeeded, but the process died before invalidating old index rows.
    assert server.search("old")["matches"] == []
    monkeypatch.setattr(
        storage,
        "list_documents",
        lambda _root: (_ for _ in ()).throw(
            AssertionError("Queued work must not scan all documents")
        ),
    )
    assert server.reconcile_once({first["document_id"]}) == 1
    assert server.reconcile_once({first["document_id"]}) == 0
    assert calls == [
        (first["document_id"], "v1", b"old evidence"),
        (second["document_id"], "v2", b"current evidence"),
    ]
    assert len(storage.list_versions(data, first["document_id"])) == 2
    current = dict(stale, version="v2")
    monkeypatch.setattr(search, "find_documents", lambda *args, **kwargs: [current])

    def judge(query, matches, **kwargs):
        storage.save_file(data, b"newer evidence", "test.txt", document_id=first["document_id"])
        return {"status": "evaluated", "matches": matches}

    monkeypatch.setattr(jev, "judge_matches", judge)
    result = server.search("current", mode="answer")
    assert result["matches"] == []
    assert "matches" not in result["evaluation"]
