"""Transfer retry integrity through the real MCP stdio connection."""

import asyncio
import base64
import hashlib
import uuid

from mcp import Client

from client import call, server_parameters


def test_committed_chunk_retry_checks_bytes_and_original_version(tmp_path):
    async def exercise():
        content = b"original chunk bytes"
        request = {
            "filename": "retry.bin",
            "request_id": str(uuid.uuid4()),
            "offset": 0,
            "total_size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "content_base64": base64.b64encode(content).decode(),
            "final": True,
        }
        parameters = server_parameters(str(tmp_path / "data"), storage_only=True)
        parameters.env["TYPESAFE_API_KEY"] = ""
        async with Client(parameters) as session:
            saved = (await call(session, "upload", {"files": [request]}))["files"][0]
            assert saved["stored"] and saved["version"] == "v1"
            updated = (
                await call(
                    session,
                    "upload",
                    {
                        "files": [
                            {
                                "filename": "retry.bin",
                                "document_id": saved["document_id"],
                                "expected_version": "v1",
                                "content_base64": base64.b64encode(b"new head").decode(),
                            }
                        ]
                    },
                )
            )["files"][0]
            assert updated["version"] == "v2"
        # The receipt survives restart and refers to v1, even after a newer head.
        async with Client(parameters) as session:
            good = (await call(session, "upload", {"files": [request]}))["files"][0]
            assert good["stored"] and good["version"] == "v1"
            altered = dict(request, content_base64=base64.b64encode(b"X" * len(content)).decode())
            mixed = (await call(session, "upload", {"files": [altered, request]}))["files"]
            assert mixed[0]["stored"] is False
            assert "Retry chunk differs" in mixed[0]["error"]
            assert mixed[1]["stored"] and mixed[1]["version"] == "v1"
            original = (
                await call(
                    session,
                    "download",
                    {
                        "files": [
                            {
                                "document_id": saved["document_id"],
                                "version": "v1",
                                "history": True,
                            }
                        ]
                    },
                )
            )["files"][0]
            assert base64.b64decode(original["content_base64"]) == content
            assert [v["version"] for v in original["versions"]] == ["v1", "v2"]

    asyncio.run(exercise())
