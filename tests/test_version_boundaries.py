"""Version column padding must not cap uploads or hide permanent history."""

import asyncio
import base64
import hashlib
import uuid

import pytest
from mcp import Client

from app import storage
from client import call, server_parameters


@pytest.mark.parametrize("highest", [10, 100, 1000])
def test_rocfl_padded_tsv_versions_are_normalized_and_sorted(tmp_path, monkeypatch, highest):
    # rocfl 1.7.0 right-aligns the version column even with --tsv.
    numbers = [highest, 1, highest - 1, 2]
    width = len(f"v{highest}")
    output = "".join(
        f"{f'v{number}':>{width}}\tSymbiknow\tNA\t2026-10-14\tupload request\n"
        for number in numbers
    ).encode()
    monkeypatch.setattr(storage, "_run", lambda *args: output)

    def read_metadata(root, document_id, version):
        storage._validate_version(version)
        return {"document_id": document_id, "version": version}

    monkeypatch.setattr(storage, "read_metadata", read_metadata)
    assert [row["version"] for row in storage.list_versions(tmp_path, "document")] == [
        f"v{number}" for number in sorted(numbers)
    ]


def test_mcp_updates_history_and_retries_across_v10(tmp_path):
    """Real MCP process + native rocfl, including client/server restart at v10."""
    async def exercise():
        root = tmp_path / "data"
        document_id = str(uuid.uuid4())
        requests = []
        contents = []
        # A second MCP process resumes the same store at the failing boundary.
        for first, last in [(1, 10), (11, 12)]:
            async with Client(server_parameters(str(root), storage_only=True)) as client:
                for number in range(first, last + 1):
                    content = f"Revision {number}\n".encode() + bytes(range(256))
                    contents.append(content)
                    request = {
                        "document_id": document_id,
                        "filename": "history.bin",
                        "request_id": str(uuid.uuid4()),
                        "content_base64": base64.b64encode(content).decode(),
                    }
                    if number > 1:
                        request["expected_version"] = f"v{number - 1}"
                    requests.append(request)
                    response = await call(client, "upload", {"files": [request]})
                    saved = response["files"][0]
                    assert saved["stored"], saved
                    assert saved["version"] == f"v{number}"
                    # At v10 this used to fail, even for a successfully committed request.
                    replay = await call(client, "upload", {"files": [request]})
                    assert replay["files"][0]["stored"], replay
                    assert replay["files"][0]["version"] == saved["version"], replay
                history = await call(client, "download", {
                    "files": [{"document_id": document_id, "history": True}]
                })
                assert [v["version"] for v in history["files"][0]["versions"]] == [
                    f"v{number}" for number in range(1, last + 1)
                ]

        async with Client(server_parameters(str(root), storage_only=True)) as client:
            old_retry = await call(client, "upload", {"files": [requests[0]]})
            assert old_retry["files"][0]["version"] == "v1"
            changed_retry = await call(client, "upload", {
                "files": [requests[0] | {"content_base64": base64.b64encode(b"bad").decode()}]
            })
            assert not changed_retry["files"][0]["stored"]
            assert "different" in changed_retry["files"][0]["error"]
            stale = await call(client, "upload", {
                "files": [requests[-1] | {"request_id": str(uuid.uuid4()), "expected_version": "v10"}]
            })
            assert not stale["files"][0]["stored"]
            assert "Expected v10, found v12" in stale["files"][0]["error"]
            downloaded = await call(client, "download", {"files": [
                {"document_id": document_id, "version": f"v{n}"} for n in range(1, 13)
            ]})
            for content, result in zip(contents, downloaded["files"], strict=True):
                assert base64.b64decode(result["content_base64"]) == content
                assert result["sha256"] == hashlib.sha256(content).hexdigest()

        assert storage.current_version(root, document_id) == "v12"
        assert len(storage.list_versions(root, document_id)) == 12
        storage._run(root, "validate", "-l", "error")

    asyncio.run(exercise())
