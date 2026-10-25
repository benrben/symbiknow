"""A live stdio MCP → OCFL → Docling → EmbeddingGemma 2 → Jev check."""

import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid

# This filename is also the SDK package name. Direct script execution puts
# scripts/checks first on sys.path; remove it before importing the real SDK.
sys.path[:] = [entry for entry in sys.path if Path(entry).resolve() != Path(__file__).resolve().parent]
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from dotenv import load_dotenv  # noqa: E402
from mcp import Client  # noqa: E402
from symbiknow.cli.client import server_parameters  # noqa: E402

load_dotenv(Path(__file__).resolve().parents[2] / ".env")
os.environ.setdefault("HF_HOME", str(Path("data/models").resolve()))


async def call(session, name, arguments, *, timeout=240):
    """Resolve current durable MCP responses with a bounded deadline.

    Use raw SDK calls so this integration probe independently checks the public
    job contract rather than inheriting the CLI's polling implementation.
    """
    async def request(tool, values):
        response = await session.call_tool(tool, values)
        if response.is_error:
            raise RuntimeError("; ".join(getattr(block, "text", "") for block in response.content))
        if not isinstance(response.structured_content, dict):
            raise RuntimeError("MCP response has no structured content")
        return response.structured_content

    async def resolve(value):
        delay = 0.05
        while "job_id" in value:
            if value.get("status") == "failed":
                raise RuntimeError(value.get("error") or "MCP job failed")
            if value.get("status") == "completed" and "result" in value:
                return value["result"]
            await asyncio.sleep(delay)
            delay = min(2, delay * 1.5)
            value = await request("get_job", {"job_id": value["job_id"], "detail": "full"})
        return value

    async def operation():
        value = await resolve(await request(name, arguments))
        if name in {"upload", "download"}:
            value["files"] = [await resolve(item) for item in value.get("files", [])]
            for item in value["files"]:
                if item.get("error"):
                    raise RuntimeError(item["error"])
        return value

    return await asyncio.wait_for(operation(), timeout)


async def run():
    with tempfile.TemporaryDirectory(prefix="symbiknow-live-mcp-") as data:
        async with Client(server_parameters(data)) as session:
            tools = await session.list_tools()
            assert {t.name for t in tools.tools} == {
                "upload",
                "download",
                "search",
                "upload_folder",
                "download_folder",
                "remove_file",
                "ask",
                "get_job",
                "resolve_jev_decision",
                "list_documents", "get_taxonomy", "list_jev_decisions", "get_organization_history", "list_jobs",
            }
            original = b"France is in Europe. The capital of France is Paris."
            started = time.perf_counter()
            saved = (
                await call(
                    session,
                    "upload",
                    {
                        "files": [
                            {
                                "filename": "France.txt",
                                "mime_type": "text/plain",
                                "source": "synthetic-fixture",
                                "request_id": str(uuid.uuid4()),
                                "content_base64": base64.b64encode(original).decode(),
                            }
                        ]
                    },
                )
            )["files"][0]
            upload_seconds = time.perf_counter() - started
            assert saved["stored"]
            deadline = time.monotonic() + 240
            while True:
                downloaded = (
                    await call(
                        session,
                        "download",
                        {
                            "files": [
                                {
                                    "document_id": saved["document_id"],
                                    "version": "v1",
                                }
                            ]
                        },
                    )
                )["files"][0]
                assert base64.b64decode(downloaded["content_base64"]) == original
                if downloaded.get("searchable"):
                    break
                if downloaded.get("indexing_status") in {"failed", "unsupported", "empty"}:
                    raise RuntimeError(downloaded)
                if time.monotonic() >= deadline:
                    raise TimeoutError("Live indexing did not finish within 240 seconds")
                await asyncio.sleep(0.25)
            searchable_seconds = time.perf_counter() - started
            started = time.perf_counter()
            answer = await call(
                session,
                "search",
                {"query": "What is the capital of France?", "mode": "answer", "limit": 3},
            )
            query_seconds = time.perf_counter() - started
            assert answer["matches"][0]["document_id"] == saved["document_id"]
            assert answer["matches"][0]["version"] == "v1"
            assert answer["evaluation"]["status"] == "evaluated"
            assert answer["matches"][0]["jev"]["label"] == "direct"
            for _ in range(40):
                organization = (
                    await call(
                        session,
                        "search",
                        {
                            "query": "France",
                            "mode": "keyword",
                            "limit": 1,
                            "detail": "full",
                        },
                    )
                )["matches"][0]
                if organization["organization_status"] == "evaluated":
                    break
                await asyncio.sleep(0.25)
            assert organization["organization_status"] == "evaluated"
            return {
                "tools": sorted(t.name for t in tools.tools),
                "real_bytes_verified": True,
                "model": "google/embeddinggemma-2",
                "jev": answer["matches"][0]["jev"],
                "organization": {
                    key: organization[key]
                    for key in ("organization_status", "folder", "groups", "links")
                },
                "upload_seconds": upload_seconds,
                "searchable_seconds": searchable_seconds,
                "answer_search_seconds": query_seconds,
            }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("artifacts/mcp-validation.json"))
    args = parser.parse_args()
    result = asyncio.run(run())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
